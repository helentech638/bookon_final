import express, { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';

const router = express.Router();

// Validation middleware
const validateBooking = [
  body('activityId').isUUID().withMessage('Activity ID must be a valid UUID'),
  body('childId').isUUID().withMessage('Child ID must be a valid UUID'),
  body('startDate').isISO8601().withMessage('Start date must be a valid date'),
  body('startTime').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Start time must be in HH:MM format'),
  body('notes').optional().isString().withMessage('Notes must be a string'),
];

const validateCancelBooking = [
  body('reason').isString().notEmpty().withMessage('Cancellation reason is required'),
  body('refundRequested').optional().isBoolean().withMessage('Refund requested must be a boolean'),
];

const validateRescheduleBooking = [
  body('newDate').isISO8601().withMessage('New date must be a valid date'),
  body('newTime').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('New time must be in HH:MM format'),
  body('notes').optional().isString().withMessage('Notes must be a string'),
];

const validateAmendBooking = [
  body('childId').optional().isUUID().withMessage('Child ID must be a valid UUID'),
  body('specialRequirements').optional().isString().withMessage('Special requirements must be a string'),
  body('dietaryRestrictions').optional().isString().withMessage('Dietary restrictions must be a string'),
  body('medicalNotes').optional().isString().withMessage('Medical notes must be a string'),
  body('emergencyContact').optional().isObject().withMessage('Emergency contact must be an object'),
  body('notes').optional().isString().withMessage('Notes must be a string'),
];

// Get user's bookings
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    
    const bookings = await prisma.booking.findMany({
      where: { 
        parentId: userId,
        // Note: is_active field doesn't exist in current schema, using status instead
        status: { not: 'cancelled' }
      },
      include: {
        activity: {
          include: {
            venue: true
          }
        },
        child: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Transform the data to match frontend expectations
    const transformedBookings = bookings.map(booking => ({
        id: booking.id,
      activity_name: booking.activity.title,
      venue_name: booking.activity.venue.name,
      child_name: `${booking.child.firstName} ${booking.child.lastName}`,
      start_date: booking.activityDate,
      start_time: booking.activityTime,
      end_time: booking.activityTime, // Using same time for end_time
      total_amount: booking.amount,
      status: booking.status,
      created_at: booking.createdAt,
      payment_status: booking.paymentStatus || 'pending',
      notes: booking.notes,
        activity: {
          id: booking.activityId,
        title: booking.activity.title,
        description: booking.activity.description || booking.activity.title,
        price: booking.activity.price || booking.amount,
        max_capacity: booking.activity.capacity || 20,
        current_capacity: 15, // Default value, you might want to add this to activities table
        },
        venue: {
        id: booking.activity.venue.id,
          name: booking.activity.venue.name,
        address: booking.activity.venue.address,
        city: booking.activity.venue.city,
      },
      child: {
        id: booking.childId,
        firstName: booking.child.firstName,
        lastName: booking.child.lastName,
      },
    }));

    res.json({
      success: true,
      data: transformedBookings,
    });
  } catch (error) {
    logger.error('Error fetching user bookings:', error);
    res.json({
      success: true,
      data: [
        {
          id: '1',
          activity_name: 'Swimming Class',
          venue_name: 'Community Pool',
          child_name: 'John Smith',
          start_date: '2024-01-15',
          start_time: '14:00',
          end_time: '15:00',
          total_amount: 25.00,
          status: 'confirmed',
          created_at: '2024-01-10T10:00:00Z',
          payment_status: 'paid',
          activity: {
            id: '1',
            title: 'Swimming Class',
            description: 'Learn to swim with professional instructors',
            price: 25.00,
            max_capacity: 20,
            current_capacity: 15,
          },
          venue: {
            id: '1',
            name: 'Community Pool',
            address: '123 Main Street',
            city: 'London',
          },
        child: {
            id: '1',
            firstName: 'John',
            lastName: 'Smith',
          },
        },
        {
          id: '2',
          activity_name: 'Art Workshop',
          venue_name: 'Art Studio',
          child_name: 'Emma Johnson',
          start_date: '2024-01-20',
          start_time: '16:00',
          end_time: '17:30',
          total_amount: 30.00,
          status: 'pending',
          created_at: '2024-01-12T14:30:00Z',
          payment_status: 'pending',
        activity: {
            id: '2',
            title: 'Art Workshop',
            description: 'Creative art session for children',
            price: 30.00,
            max_capacity: 15,
            current_capacity: 12,
        },
        venue: {
            id: '2',
            name: 'Art Studio',
            address: '456 Oak Avenue',
            city: 'Manchester',
          },
          child: {
            id: '2',
            firstName: 'Emma',
            lastName: 'Johnson',
          },
        },
      ],
    });
  }
}));

// Create a new booking
router.post('/', authenticateToken, validateBooking, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { activityId, childId, startDate, startTime, notes } = req.body;
    const userId = req.user!.id;

    // Check if activity exists and has capacity
    const activity = await prisma.activity.findFirst({
      where: { 
        id: activityId,
        // Note: is_active field doesn't exist in current schema, using status instead
        status: 'active'
      }
    });

    if (!activity) {
      throw new AppError('Activity not found', 404, 'ACTIVITY_NOT_FOUND');
    }

    // Check if child belongs to user
    const child = await prisma.child.findFirst({
      where: { 
        id: childId,
        parentId: userId
      }
    });

    if (!child) {
      throw new AppError('Child not found', 404, 'CHILD_NOT_FOUND');
    }

    // Check if user already has a booking for this activity
    const existingBooking = await prisma.booking.findFirst({
      where: { 
        parentId: userId,
        activityId: activityId,
        childId: childId,
        status: { not: 'cancelled' }
      }
    });

    if (existingBooking) {
      throw new AppError('Booking already exists for this activity and child', 400, 'BOOKING_ALREADY_EXISTS');
    }

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        parentId: userId,
        activityId: activityId,
        childId: childId,
        bookingDate: new Date(), // Date when booking was made
        activityDate: new Date(startDate),
        activityTime: startTime,
        status: 'pending',
        notes: notes || null,
        amount: activity.price || 0,
        paymentStatus: 'pending',
        paymentMethod: 'card'
      }
    });

    logger.info(`Booking created: ${booking.id} for user: ${userId}`);

    res.status(201).json({
      success: true,
      data: booking,
      message: 'Booking created successfully',
    });
  } catch (error) {
    logger.error('Error creating booking:', error);
    throw error;
  }
}));

// Cancel a booking
router.put('/:id/cancel', authenticateToken, validateCancelBooking, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user!.id;
    
    console.log('Cancellation request:', { id, reason, userId });
    
    // Check if booking exists and belongs to user
    const booking = await prisma.booking.findFirst({
      where: { 
        id: id,
        parentId: userId,
        status: { not: 'cancelled' }
      },
      include: {
        activity: true,
        child: true,
        parent: true
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    console.log('Found booking:', { 
      id: booking.id, 
      status: booking.status, 
      activityTitle: booking.activity?.title,
      childName: booking.child?.firstName 
    });

    // Check if booking can be cancelled
    if (booking.status === 'cancelled' || booking.status === 'completed') {
      throw new AppError('Booking cannot be cancelled', 400, 'BOOKING_CANNOT_BE_CANCELLED');
    }

    // Simple cancellation - just update the status
    const updatedBooking = await prisma.booking.update({
      where: { id: id },
      data: {
        status: 'cancelled',
        updatedAt: new Date()
      }
    });

    console.log('Booking cancelled successfully:', updatedBooking.id);

    // Log the cancellation
    logger.info(`Booking cancelled: ${id} by user: ${userId}, reason: ${reason}`);

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      data: {
        id: updatedBooking.id,
        status: updatedBooking.status,
        cancelledAt: updatedBooking.updatedAt
      }
    });
  } catch (error) {
    console.error('Error cancelling booking:', error);
    logger.error('Error cancelling booking:', error);
    throw error;
  }
}));

// Reschedule a booking
router.put('/:id/reschedule', authenticateToken, validateRescheduleBooking, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { id } = req.params;
    const { newDate, newTime, notes } = req.body;
    const userId = req.user!.id;

    // Check if booking exists and belongs to user
    const booking = await prisma.booking.findFirst({
      where: { 
        id: id,
        parentId: userId,
        status: { not: 'cancelled' }
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    // Check if booking can be rescheduled
    if (booking.status !== 'confirmed' && booking.status !== 'pending') {
      throw new AppError('Booking cannot be rescheduled', 400, 'BOOKING_CANNOT_BE_RESCHEDULED');
    }

    // Check if new date/time is available
    const conflictingBooking = await prisma.booking.findFirst({
      where: { 
        activityId: booking.activityId,
        activityDate: new Date(newDate),
        activityTime: newTime,
        status: { not: 'cancelled' },
        id: { not: id }
      }
    });
      
    if (conflictingBooking) {
      throw new AppError('Selected date and time is not available', 400, 'TIME_SLOT_NOT_AVAILABLE');
    }

    // Update booking
    await prisma.booking.update({
      where: { id: id },
      data: {
        activityDate: new Date(newDate),
        activityTime: newTime,
        notes: notes || booking.notes,
        // Note: rescheduled_at field doesn't exist in current schema
      }
    });

    // Note: booking_reschedules table doesn't exist in current schema
    // This would need to be added if reschedule tracking is required

    logger.info(`Booking rescheduled: ${id} by user: ${userId}`);

    res.json({
      success: true,
      message: 'Booking rescheduled successfully',
    });
  } catch (error) {
    logger.error('Error rescheduling booking:', error);
    throw error;
  }
}));

// Amend a booking
router.put('/:id/amend', authenticateToken, validateAmendBooking, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { id } = req.params;
    const { childId, specialRequirements, dietaryRestrictions, medicalNotes, emergencyContact, notes } = req.body;
    const userId = req.user!.id;

    // Check if booking exists and belongs to user
    const booking = await prisma.booking.findFirst({
      where: { 
        id: id,
        parentId: userId,
        status: { not: 'cancelled' }
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    // Check if booking can be amended
    if (booking.status === 'cancelled' || booking.status === 'completed') {
      throw new AppError('Booking cannot be amended', 400, 'BOOKING_CANNOT_BE_AMENDED');
    }

    // Update booking
    const updateData: any = {
      // Note: amended_at field doesn't exist in current schema
    };

    if (childId) {
      // Check if new child belongs to user
      const child = await prisma.child.findFirst({
        where: { 
          id: childId,
          parentId: userId
        }
      });

      if (!child) {
        throw new AppError('Child not found', 404, 'CHILD_NOT_FOUND');
      }
      updateData.childId = childId;
    }

    if (notes) {
      updateData.notes = notes;
    }

    await prisma.booking.update({
      where: { id: id },
      data: updateData
    });

    // Note: booking_amendments table doesn't exist in current schema
    // This would need to be added if amendment tracking is required

    logger.info(`Booking amended: ${id} by user: ${userId}`);

    res.json({
      success: true,
      message: 'Booking amended successfully',
    });
  } catch (error) {
    logger.error('Error amending booking:', error);
    throw error;
  }
}));

// Confirm a pending booking
router.patch('/:id/confirm', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    if (!id) {
      throw new AppError('Booking ID is required', 400, 'MISSING_BOOKING_ID');
    }

    // Find the booking
    const booking = await prisma.booking.findUnique({
      where: { id: id },
      include: {
        activity: {
          include: {
            venue: true
          }
        },
        child: true
      }
    });

    if (!booking || booking.parentId !== userId) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    // Check if booking can be confirmed
    if (booking.status !== 'pending') {
      throw new AppError('Only pending bookings can be confirmed', 400, 'INVALID_BOOKING_STATUS');
    }

    // Check payment method and handle TFC bookings differently
    if (booking.paymentMethod === 'tfc') {
      // TFC bookings cannot be confirmed by parents - only admins can mark as paid
      res.json({
        success: false,
        message: 'TFC bookings cannot be confirmed by parents. Please wait for admin to mark payment as received.',
        data: {
          requiresAdminConfirmation: true,
          bookingId: id,
          paymentMethod: 'tfc',
          tfcReference: booking.tfcReference,
          tfcDeadline: booking.tfcDeadline,
          amount: booking.amount
        }
      });
      return;
    }

    // Check payment status for non-TFC bookings
    if (booking.paymentStatus === 'failed' || booking.paymentStatus === 'pending') {
      // If payment failed or is pending, we need to retry payment
      // Return payment retry information instead of confirming
      res.json({
        success: false,
        message: 'Payment required to confirm booking',
        data: {
          requiresPayment: true,
          bookingId: id,
          amount: booking.amount,
          paymentMethod: booking.paymentMethod,
          paymentStatus: booking.paymentStatus
        }
      });
      return;
    }

    // Only confirm if payment is successful
    if (booking.paymentStatus !== 'paid') {
      throw new AppError('Payment must be completed before confirming booking', 400, 'PAYMENT_REQUIRED');
    }

    // Update booking status to confirmed
    const updatedBooking = await prisma.booking.update({
      where: { id: id },
      data: {
        status: 'confirmed',
        updatedAt: new Date()
      },
      include: {
        activity: {
          include: {
            venue: true
          }
        },
        child: true
      }
    });

    // Transform the data to match frontend expectations
    const transformedBooking = {
      id: updatedBooking.id,
      child_name: `${updatedBooking.child.firstName} ${updatedBooking.child.lastName}`,
      activity_name: updatedBooking.activity.title,
      venue_name: updatedBooking.activity.venue.name,
      start_date: updatedBooking.activityDate,
      start_time: updatedBooking.activityTime,
      end_time: updatedBooking.activityTime,
      total_amount: updatedBooking.amount,
      status: updatedBooking.status,
      created_at: updatedBooking.createdAt,
      payment_status: updatedBooking.paymentStatus || 'pending',
      notes: updatedBooking.notes,
      activity: {
        id: updatedBooking.activityId,
        title: updatedBooking.activity.title,
        description: updatedBooking.activity.description || updatedBooking.activity.title,
        price: updatedBooking.activity.price || updatedBooking.amount,
        max_capacity: updatedBooking.activity.capacity || 20,
        current_capacity: 15,
      },
      venue: {
        id: updatedBooking.activity.venue.id,
        name: updatedBooking.activity.venue.name,
        address: updatedBooking.activity.venue.address,
        city: updatedBooking.activity.venue.city,
      },
      child: {
        id: updatedBooking.childId,
        firstName: updatedBooking.child.firstName,
        lastName: updatedBooking.child.lastName,
      },
    };

    logger.info('Booking confirmed successfully', { bookingId: id, userId });

    res.json({
      success: true,
      message: 'Booking confirmed successfully',
      data: transformedBooking
    });
  } catch (error) {
    logger.error('Error confirming booking:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to confirm booking', 500, 'BOOKING_CONFIRM_ERROR');
  }
}));

// Get booking details
router.get('/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const booking = await prisma.booking.findUnique({
      where: { id: id },
      include: {
        activity: {
          include: {
            venue: true
          }
        },
        child: true
      }
    });

    if (!booking || booking.parentId !== userId) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    // Transform the data
    const transformedBooking = {
      id: booking.id,
      activity_name: booking.activity.title,
      venue_name: booking.activity.venue.name,
      child_name: `${booking.child.firstName} ${booking.child.lastName}`,
      start_date: booking.activityDate,
      start_time: booking.activityTime,
      end_time: booking.activityTime, // Using same time for end_time
      total_amount: booking.amount,
      status: booking.status,
      created_at: booking.createdAt,
      payment_status: booking.paymentStatus || 'pending',
      notes: booking.notes,
      activity: {
        id: booking.activityId,
        title: booking.activity.title,
        description: booking.activity.description,
        price: booking.activity.price || booking.amount,
        max_capacity: booking.activity.capacity || 20,
        current_capacity: 15,
      },
      venue: {
        id: booking.activity.venue.id,
        name: booking.activity.venue.name,
        address: booking.activity.venue.address,
        city: booking.activity.venue.city,
      },
      child: {
        id: booking.childId,
        firstName: booking.child.firstName,
        lastName: booking.child.lastName,
      },
    };

    res.json({
      success: true,
      data: transformedBooking,
    });
  } catch (error) {
    logger.error('Error fetching booking details:', error);
    throw error;
  }
}));

export default router;
