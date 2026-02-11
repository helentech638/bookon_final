import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { cancellationService } from '../services/cancellationService';
import { logger } from '../utils/logger';
import { validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';

const router = Router();

// Validation middleware
const validateCancellationRequest = [
  body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Valid reason is required'),
  body('bookingId').isUUID().withMessage('Valid booking ID is required')
];

const validateBookingId = [
  param('id').isUUID().withMessage('Valid booking ID is required')
];

// Check cancellation eligibility
router.post('/check-eligibility/:id', authenticateToken, validateBookingId, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const userId = req.user!.id;
    const { id } = req.params;

    // Verify booking belongs to user
    const booking = await prisma.booking.findFirst({
      where: {
        id,
        parentId: userId
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    const eligibility = await cancellationService.determineCancellationEligibility(id, new Date());

    res.json({
      success: true,
      data: eligibility
    });
  } catch (error) {
    logger.error('Error checking cancellation eligibility:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to check cancellation eligibility', 500, 'CANCELLATION_CHECK_ERROR');
  }
}));

// Request cancellation
router.post('/request', authenticateToken, validateCancellationRequest, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const userId = req.user!.id;
    const { bookingId, reason } = req.body;

    // Verify booking belongs to user
    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        parentId: userId,
        status: { not: 'cancelled' }
      }
    });

    if (!booking) {
      throw new AppError('Booking not found or already cancelled', 404, 'BOOKING_NOT_FOUND');
    }

    const result = await cancellationService.processCancellation(bookingId, userId, reason);

    logger.info('Cancellation requested via API', {
      userId,
      bookingId,
      reason,
      refundTransactionId: result.refundTransactionId,
      creditId: result.creditId
    });

    res.status(201).json({
      success: true,
      message: 'Cancellation request processed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error processing cancellation request:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process cancellation request', 500, 'CANCELLATION_REQUEST_ERROR');
  }
}));

// Provider cancellation (admin only)
router.post('/provider-cancel/:id', authenticateToken, validateBookingId, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { id } = req.params;
    const { reason, refundMethod = 'parent_choice' } = req.body;
    const adminId = user.id;

    const result = await cancellationService.processProviderCancellation(id, adminId, reason, refundMethod);

    logger.info('Provider cancellation via API', {
      adminId,
      bookingId: id,
      reason,
      refundMethod,
      refundTransactionId: result.refundTransactionId,
      creditId: result.creditId
    });

    res.status(201).json({
      success: true,
      message: 'Provider cancellation processed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error processing provider cancellation:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process provider cancellation', 500, 'PROVIDER_CANCELLATION_ERROR');
  }
}));

// Get cancellation history for a booking
router.get('/history/:id', authenticateToken, validateBookingId, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Verify booking belongs to user or user is admin
    const booking = await prisma.booking.findFirst({
      where: {
        id,
        OR: [
          { parentId: userId },
          { parentId: userId } // Admin can see all
        ]
      }
    });

    if (!booking && req.user!.role !== 'admin') {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    const history = await cancellationService.getCancellationHistory(id);

    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    logger.error('Error getting cancellation history:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get cancellation history', 500, 'CANCELLATION_HISTORY_ERROR');
  }
}));

// Get cancellation statistics (admin only)
router.get('/stats', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { venueId } = req.query;
    const stats = await cancellationService.getCancellationStats(venueId as string);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error getting cancellation stats:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get cancellation stats', 500, 'CANCELLATION_STATS_ERROR');
  }
}));

// Get pending cancellation requests (admin only)
router.get('/pending', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { venueId } = req.query;

    const whereClause: any = {
      status: 'pending'
    };

    if (venueId) {
      whereClause.booking = {
        activity: {
          venueId: venueId
        }
      };
    }

    const pendingRefunds = await prisma.refundTransaction.findMany({
      where: whereClause,
      include: {
        booking: {
          include: {
            activity: {
              include: {
                venue: {
                  select: {
                    name: true,
                    id: true
                  }
                }
              }
            },
            child: {
              select: {
                firstName: true,
                lastName: true
              }
            },
            parent: {
              select: {
                firstName: true,
                lastName: true,
                email: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formattedRefunds = pendingRefunds.map(refund => ({
      id: refund.id,
      bookingId: refund.bookingId,
      amount: refund.amount,
      method: refund.method,
      fee: refund.fee,
      reason: refund.reason,
      status: refund.status,
      createdAt: refund.createdAt,
      child: `${refund.booking.child.firstName} ${refund.booking.child.lastName}`,
      parent: `${refund.booking.parent.firstName} ${refund.booking.parent.lastName}`,
      parentEmail: refund.booking.parent.email,
      activity: refund.booking.activity.title,
      venue: refund.booking.activity.venue.name,
      venueId: refund.booking.activity.venue.id,
      auditTrail: refund.auditTrail
    }));

    res.json({
      success: true,
      data: formattedRefunds
    });
  } catch (error) {
    logger.error('Error getting pending cancellations:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get pending cancellations', 500, 'PENDING_CANCELLATIONS_ERROR');
  }
}));

// Process refund (admin only)
router.post('/process-refund/:id', authenticateToken, validateBookingId, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { id } = req.params;
    const { stripeRefundId, notes } = req.body;
    const adminId = user.id;

    const refund = await prisma.refundTransaction.findUnique({
      where: { id }
    });

    if (!refund) {
      throw new AppError('Refund transaction not found', 404, 'REFUND_NOT_FOUND');
    }

    if (refund.status !== 'pending') {
      throw new AppError('Refund has already been processed', 400, 'REFUND_ALREADY_PROCESSED');
    }

    // Update refund status
    const updatedRefund = await prisma.refundTransaction.update({
      where: { id },
      data: {
        status: 'processed',
        processedAt: new Date(),
        stripeRefundId: stripeRefundId || null,
        auditTrail: {
          ...refund.auditTrail as any,
          processedBy: adminId,
          processedAt: new Date(),
          notes: notes || null
        }
      }
    });

    logger.info('Refund processed via API', {
      adminId,
      refundId: id,
      amount: refund.amount,
      stripeRefundId
    });

    res.json({
      success: true,
      message: 'Refund processed successfully',
      data: updatedRefund
    });
  } catch (error) {
    logger.error('Error processing refund:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process refund', 500, 'REFUND_PROCESS_ERROR');
  }
}));

export default router;
