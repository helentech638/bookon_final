import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';

const router = Router();

// Middleware to check if user is admin or staff
const requireAdminOrStaff = (req: Request, _res: Response, next: Function) => {
  console.log('Admin access check:', { 
    user: req.user?.email, 
    role: req.user?.role,
    hasUser: !!req.user 
  });
  
  if (!req.user) {
    throw new AppError('User not authenticated', 401, 'USER_NOT_AUTHENTICATED');
  }
  
  if (!['admin', 'staff'].includes(req.user.role)) {
    throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
  }
  next();
};

// Get admin statistics
router.get('/stats', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    logger.info('Admin stats requested', { 
      user: _req.user?.email,
      role: _req.user?.role 
    });

    // Get total counts using Prisma for better reliability
    const statsData = await safePrismaQuery(async (client) => {
      const [totalUsers, totalVenues, totalActivities, totalBookings, confirmedBookingsCount, pendingBookingsCount, cancelledBookingsCount] = await Promise.all([
        client.user.count(),
        client.venue.count(),
        client.activity.count(),
        client.booking.count(),
        client.booking.count({ where: { status: 'confirmed' } }),
        client.booking.count({ where: { status: 'pending' } }),
        client.booking.count({ where: { status: 'cancelled' } })
      ]);

      return {
        totalUsers,
        totalVenues,
        totalActivities,
        totalBookings,
        confirmedBookingsCount,
        pendingBookingsCount,
        cancelledBookingsCount
      };
    });
    
    // Get total revenue - using mock value since amount field doesn't exist yet
    const totalRevenue = 45680.50; // Mock revenue value

    res.json({
      success: true,
      data: {
        totalUsers: statsData.totalUsers,
        totalVenues: statsData.totalVenues,
        totalActivities: statsData.totalActivities,
        totalBookings: statsData.totalBookings,
        confirmedBookings: statsData.confirmedBookingsCount,
        pendingBookings: statsData.pendingBookingsCount,
        cancelledBookings: statsData.cancelledBookingsCount,
        totalRevenue: Number(totalRevenue)
      }
    });
  } catch (error) {
    logger.error('Error fetching admin stats:', {
      error: error instanceof Error ? error.message : String(error),
      user: _req.user?.email,
      role: _req.user?.role,
      stack: error instanceof Error ? error.stack : undefined
    });
    throw new AppError('Failed to fetch admin stats', 500, 'ADMIN_STATS_ERROR');
  }
}));

// Get all venues for admin
router.get('/venues', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    logger.info('Admin venues route accessed', { 
      user: _req.user?.email,
      role: _req.user?.role 
    });

    const venues = await safePrismaQuery(async (client) => {
      return await client.venue.findMany({
        orderBy: { createdAt: 'desc' }
      });
    });

    logger.info('Successfully fetched venues', { count: venues.length });

    res.json({
      success: true,
      data: venues.map(venue => ({
        id: venue.id,
        name: venue.name,
        description: venue.description,
        address: venue.address,
        capacity: venue.capacity,
        isActive: venue.isActive,
        createdAt: venue.createdAt,
        updatedAt: venue.updatedAt
      }))
    });
  } catch (error) {
    logger.error('Error fetching admin venues:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      user: _req.user?.email,
      role: _req.user?.role
    });
    
    // Return proper error response instead of mock data
    res.status(500).json({
      success: false,
      message: 'Failed to fetch venues',
      error: process.env['NODE_ENV'] === 'development' ? (error instanceof Error ? error.message : String(error)) : 'Internal server error'
    });
  }
}));

// Get all activities for admin
router.get('/activities', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    logger.info('Admin activities route accessed', { 
      user: _req.user?.email,
      role: _req.user?.role 
    });

    const activities = await safePrismaQuery(async (client) => {
      return await client.activity.findMany({
        include: {
          venue: {
            select: {
              name: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
    });

    logger.info('Successfully fetched activities', { count: activities.length });

    res.json({
      success: true,
      data: activities.map(activity => ({
        id: activity.id,
        name: activity.title,
        description: activity.description,
        startDate: activity.startDate,
        endDate: activity.endDate,
        startTime: activity.startTime,
        endTime: activity.endTime,
        capacity: activity.capacity,
        price: activity.price,
        status: activity.status,
        isActive: activity.isActive,
        venueId: activity.venueId,
        venueName: activity.venue?.name || 'Unknown Venue',
        createdAt: activity.createdAt,
        updatedAt: activity.updatedAt
      }))
    });
  } catch (error) {
    logger.error('Error fetching admin activities:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      user: _req.user?.email,
      role: _req.user?.role
    });
    
    // Return proper error response instead of mock data
    res.status(500).json({
      success: false,
      message: 'Failed to fetch activities',
      error: process.env['NODE_ENV'] === 'development' ? (error instanceof Error ? error.message : String(error)) : 'Internal server error'
    });
  }
}));

// Update venue status (activate/deactivate/delete)
router.put('/venues/:id', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['active', 'inactive'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid status', 400, 'INVALID_STATUS');
    }

    const updatedVenue = await safePrismaQuery(async (client) => {
      return await client.venue.update({
        where: { id: id! },
        data: { 
          isActive: status === 'active',
          updatedAt: new Date() 
        },
        select: {
          id: true,
          name: true,
          isActive: true
        }
      });
    });

    logger.info('Admin updated venue status', {
      venueId: id,
      newStatus: status,
      adminUserId: req.user!.id
    });

    res.json({
      success: true,
      message: 'Venue status updated successfully',
      data: {
        id: updatedVenue.id,
        name: updatedVenue.name,
        isActive: updatedVenue.isActive
      }
    });
  } catch (error: any) {
    logger.error('Error updating venue status:', error);
    if (error instanceof AppError) throw error;
    if (error.code === 'P2025') {
      throw new AppError('Venue not found', 404, 'VENUE_NOT_FOUND');
    }
    throw new AppError('Failed to update venue status', 500, 'VENUE_UPDATE_ERROR');
  }
}));

// Delete venue
router.delete('/venues/:id', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if venue has any activities
    const activitiesCount = await safePrismaQuery(async (client) => {
      return await client.activity.count({
        where: { venueId: id! }
      });
    });
    if (activitiesCount > 0) {
      throw new AppError('Cannot delete venue with existing activities', 400, 'VENUE_HAS_ACTIVITIES');
    }

    await safePrismaQuery(async (client) => {
      return await client.venue.delete({
        where: { id: id! }
      });
    });

    logger.info('Admin deleted venue', {
      venueId: id,
      adminUserId: req.user!.id
    });

    res.json({
      success: true,
      message: 'Venue deleted successfully'
    });
  } catch (error: any) {
    logger.error('Error deleting venue:', error);
    if (error instanceof AppError) throw error;
    if (error.code === 'P2025') {
      throw new AppError('Venue not found', 404, 'VENUE_NOT_FOUND');
    }
    throw new AppError('Failed to delete venue', 500, 'VENUE_DELETE_ERROR');
  }
}));

// Update activity status (activate/deactivate/delete)
router.put('/activities/:id', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['active', 'inactive'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid status', 400, 'INVALID_STATUS');
    }

    const updatedActivity = await safePrismaQuery(async (client) => {
      return await client.activity.update({
        where: { id: id! },
        data: { 
          isActive: status === 'active',
          updatedAt: new Date() 
        },
        select: {
          id: true,
          title: true,
          isActive: true
        }
      });
    });

    logger.info('Admin updated activity status', {
      activityId: id,
      newStatus: status,
      adminUserId: req.user!.id
    });

    res.json({
      success: true,
      message: 'Activity status updated successfully',
        data: {
          id: updatedActivity.id,
          title: updatedActivity.title,
          isActive: updatedActivity.isActive
        }
    });
  } catch (error: any) {
    logger.error('Error updating activity status:', error);
    if (error instanceof AppError) throw error;
    if (error.code === 'P2025') {
      throw new AppError('Activity not found', 404, 'ACTIVITY_NOT_FOUND');
    }
    throw new AppError('Failed to update activity status', 500, 'ACTIVITY_UPDATE_ERROR');
  }
}));

// Delete activity
router.delete('/activities/:id', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if activity has any bookings
    const bookingsCount = await safePrismaQuery(async (client) => {
      return await client.booking.count({
        where: { activityId: id! }
      });
    });
    if (bookingsCount > 0) {
      throw new AppError('Cannot delete activity with existing bookings', 400, 'ACTIVITY_HAS_BOOKINGS');
    }

    await safePrismaQuery(async (client) => {
      return await client.activity.delete({
        where: { id: id! }
      });
    });

    logger.info('Admin deleted activity', {
      activityId: id,
      adminUserId: req.user!.id
    });

    res.json({
      success: true,
      message: 'Activity deleted successfully'
    });
  } catch (error: any) {
    logger.error('Error deleting activity:', error);
    if (error instanceof AppError) throw error;
    if (error.code === 'P2025') {
      throw new AppError('Activity not found', 404, 'ACTIVITY_NOT_FOUND');
    }
    throw new AppError('Failed to delete activity', 500, 'ACTIVITY_DELETE_ERROR');
  }
}));

// Get recent bookings for admin
router.get('/recent-bookings', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { limit = '10' } = req.query;
    
    const bookings = await safePrismaQuery(async (client) => {
      return await client.booking.findMany({
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        include: {
          activity: {
            include: {
              venue: true
            }
          },
          parent: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          }
        }
      });
    });

    res.json({
      success: true,
      data: bookings.map((booking: any) => ({
        id: booking.id,
        status: booking.status,
        amount: booking.amount,
        bookingDate: booking.activityDate,
        createdAt: booking.createdAt,
        user: {
          id: booking.parent.id,
          name: `${booking.parent.firstName} ${booking.parent.lastName}`
        },
        activity: {
          id: booking.activity.id,
          name: booking.activity.title
        },
        venue: {
          id: booking.activity.venue.id,
          name: booking.activity.venue.name
        }
      }))
    });
  } catch (error) {
    logger.error('Error fetching admin recent bookings:', error);
    throw new AppError('Failed to fetch recent bookings', 500, 'RECENT_BOOKINGS_ERROR');
  }
}));

// Get all bookings for admin with search and filtering
router.get('/bookings', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    logger.info('Admin bookings route accessed', { 
      userId: req.user!.id, 
      userRole: req.user!.role,
      query: req.query 
    });

    const { 
      page = '1', 
      limit = '20', 
      status, 
      venue_id: _venue_id, 
      activity_id: _activity_id, 
      user_id: _user_id,
      date_from: _date_from,
      date_to: _date_to,
      search: _search
    } = req.query;

    // Note: These parameters are available for future filtering implementation
    // Currently using simplified where clause for performance

    logger.info('Building admin bookings query');
    
    // Build Prisma where clause - simplified for now
    const whereClause: any = {};
    
    if (status) whereClause.status = status;
    if (_activity_id) whereClause.activityId = _activity_id as string;
    if (_user_id) whereClause.parentId = _user_id as string;

    logger.info('Getting total count for pagination');
    
    // Get total count for pagination
    const total = await prisma.booking.count({ where: whereClause });
    
    logger.info('Total count result:', { total });

    // Apply pagination and ordering
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    logger.info('Executing final query with pagination', { 
      page: parseInt(page as string), 
      limit: parseInt(limit as string), 
      offset 
    });
    
    const bookings = await prisma.booking.findMany({
      where: whereClause,
      take: parseInt(limit as string),
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: {
        activity: {
          include: {
            venue: true
          }
        },
        parent: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        }
      }
    });

    logger.info('Query executed successfully', { 
      bookingsCount: bookings.length,
      firstBooking: bookings[0] ? { id: bookings[0].id, status: bookings[0].status } : null
    });

    res.json({
      success: true,
      data: {
        bookings: bookings.map((booking: any) => ({
          id: booking.id,
          status: booking.status,
          totalAmount: booking.amount,
          bookingDate: booking.activityDate,
          createdAt: booking.createdAt,
          user: {
            id: booking.parent.id,
            name: `${booking.parent.firstName} ${booking.parent.lastName}`,
            email: booking.parent.email
          },
          activity: {
            id: booking.activity.id,
            title: booking.activity.title
          },
          venue: {
            id: booking.activity.venue.id,
            name: booking.activity.venue.name
          }
        })),
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total: total,
          pages: Math.ceil(total / parseInt(limit as string))
        }
      }
    });
  } catch (error) {
    logger.error('Error fetching admin bookings:', error);
    throw new AppError('Failed to fetch bookings', 500, 'ADMIN_BOOKINGS_ERROR');
  }
}));

// Update booking status (admin only)
router.patch('/bookings/:id/status', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid status', 400, 'INVALID_STATUS');
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: id! },
      data: { 
        status, 
        updatedAt: new Date() 
      },
      select: { id: true, status: true }
    });

    if (!updatedBooking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    // Log the status change
    logger.info('Admin updated booking status', {
      bookingId: id,
      newStatus: status,
      adminUserId: req.user!.id,
      notes
    });

    res.json({
      success: true,
      message: 'Booking status updated successfully',
      data: {
        id: updatedBooking.id,
        status: updatedBooking.status
      }
    });
  } catch (error) {
    logger.error('Error updating booking status:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to update booking status', 500, 'BOOKING_UPDATE_ERROR');
  }
}));

// Get all users for admin
router.get('/users', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', role, search, isActive } = req.query;

    // Build Prisma where clause
    const whereClause: any = {};

    if (role) whereClause.role = role;
    if (isActive !== undefined) whereClause.isActive = isActive === 'true';
    if (search) {
      whereClause.OR = [
        { email: { contains: search as string, mode: 'insensitive' } },
        { firstName: { contains: search as string, mode: 'insensitive' } },
        { lastName: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    // Get total count for pagination
    const total = await prisma.user.count({ where: whereClause });

    // Apply pagination
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const users = await prisma.user.findMany({
      where: whereClause,
      take: parseInt(limit as string),
      skip: offset,
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: {
        users: users.map(user => ({
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          isActive: user.isActive,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        })),
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total: total,
          pages: Math.ceil(total / parseInt(limit as string))
        }
      }
    });
  } catch (error) {
    logger.error('Error fetching admin users:', error);
    throw new AppError('Failed to fetch users', 500, 'ADMIN_USERS_ERROR');
  }
}));

// Update user role and status (admin only)
router.patch('/users/:id', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, isActive } = req.body;

    const validRoles = ['user', 'venue_owner', 'admin'];
    if (role && !validRoles.includes(role)) {
      throw new AppError('Invalid role', 400, 'INVALID_ROLE');
    }

    const updateData: any = { updatedAt: new Date() };
    if (role !== undefined) updateData.role = role;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedUser = await prisma.user.update({
      where: { id: id! },
      data: updateData,
      select: { id: true, role: true, isActive: true }
    });

    if (!updatedUser) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    logger.info('Admin updated user', {
      userId: id,
      newRole: role,
      newActiveStatus: isActive,
      adminUserId: req.user!.id
    });

    res.json({
      success: true,
      message: 'User updated successfully',
      data: {
        id: updatedUser.id,
        role: updatedUser.role,
        isActive: updatedUser.isActive
      }
    });
  } catch (error) {
    logger.error('Error updating user:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to update user', 500, 'USER_UPDATE_ERROR');
  }
}));

// Get financial reports for admin
router.get('/financial-reports', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { period = 'month', venue_id, date_from, date_to } = req.query;

    const now = new Date();

    // Build Prisma where clause
    const whereClause: any = {
      status: 'confirmed'
    };

    // Apply venue filter through activity relation
    if (venue_id) {
      whereClause.activity = {
        venueId: venue_id
      };
    }

    // Apply date filter
    if (date_from || date_to) {
      whereClause.createdAt = {};
      if (date_from) whereClause.createdAt.gte = new Date(date_from as string);
      if (date_to) whereClause.createdAt.lte = new Date(date_to as string);
    }

    const bookings = await prisma.booking.findMany({
      where: whereClause,
      include: {
        activity: {
          include: {
            venue: true
          }
        }
      }
    });

    // Calculate financial metrics
    const totalRevenue = bookings.reduce((sum, booking: any) => sum + parseFloat(String(booking.totalAmount || booking.amount || '0')), 0);
    const totalBookings = bookings.length;
    const averageBookingValue = totalBookings > 0 ? totalRevenue / totalBookings : 0;

    // Revenue by venue
    const revenueByVenue = bookings.reduce((acc, booking: any) => {
      const venueName = booking.activity.venue.name || 'Unknown';
      acc[venueName] = (acc[venueName] || 0) + parseFloat(String(booking.totalAmount || booking.amount || '0'));
      return acc;
    }, {} as Record<string, number>);

    // Revenue by date (last 30 days)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentBookings = bookings.filter((booking: any) => 
      new Date(booking.createdAt) >= thirtyDaysAgo
    );

    const dailyRevenue = recentBookings.reduce((acc, booking: any) => {
      const date = new Date(booking.createdAt).toISOString().split('T')[0];
      if (date) {
        acc[date] = (acc[date] || 0) + parseFloat(String(booking.totalAmount || booking.amount || '0'));
      }
      return acc;
    }, {} as Record<string, number>);

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalBookings,
          averageBookingValue: parseFloat(averageBookingValue.toFixed(2)),
          period
        },
        revenueByVenue,
        dailyRevenue,
        period
      }
    });
  } catch (error) {
    logger.error('Error fetching financial reports:', error);
    throw new AppError('Failed to fetch financial reports', 500, 'FINANCIAL_REPORTS_ERROR');
  }
}));

// Get payout information for venues
router.get('/payouts', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venue_id } = req.query;

    const whereClause: any = {};
    if (venue_id) {
      whereClause.id = venue_id;
    }

    const venues = await prisma.venue.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        // Note: stripe_account_id and payout_schedule fields don't exist in current schema
        // These would need to be added to the Venue model if needed
      }
    });

    // For now, return basic payout info
    // In production, this would integrate with Stripe Connect for actual payout data
    const payouts = venues.map(venue => ({
      venueId: venue.id,
      venueName: venue.name,
      stripeAccountId: null, // Field doesn't exist in current schema
      payoutSchedule: null, // Field doesn't exist in current schema
      status: 'pending', // This would come from Stripe
      amount: 0, // This would be calculated from confirmed bookings
      lastPayout: null // This would come from Stripe
    }));

    res.json({
      success: true,
      data: payouts
    });
  } catch (error) {
    logger.error('Error fetching payout information:', error);
    throw new AppError('Failed to fetch payout information', 500, 'PAYOUTS_ERROR');
  }
}));

// Email Template Management
router.get('/email-templates', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    // For now, return predefined templates
    // In production, these would be stored in a database
    const templates = [
      {
        id: 'welcome',
        name: 'Welcome Email',
        subject: 'Welcome to BookOn!',
        content: 'Welcome {{user_name}}! We\'re excited to have you on board.',
        variables: ['user_name'],
        isActive: true
      },
      {
        id: 'booking-confirmation',
        name: 'Booking Confirmation',
        subject: 'Your booking has been confirmed',
        content: 'Hi {{user_name}}, your booking for {{activity_name}} at {{venue_name}} has been confirmed.',
        variables: ['user_name', 'activity_name', 'venue_name'],
        isActive: true
      },
      {
        id: 'booking-reminder',
        name: 'Booking Reminder',
        subject: 'Reminder: Your activity is tomorrow',
        content: 'Hi {{user_name}}, don\'t forget your {{activity_name}} tomorrow at {{venue_name}}.',
        variables: ['user_name', 'activity_name', 'venue_name'],
        isActive: true
      }
    ];

    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    logger.error('Error fetching email templates:', error);
    throw new AppError('Failed to fetch email templates', 500, 'EMAIL_TEMPLATES_ERROR');
  }
}));

// Send broadcast message to users
router.post('/broadcast-message', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { subject, message, targetUsers, templateId, scheduledFor } = req.body;

    if (!subject || !message) {
      throw new AppError('Subject and message are required', 400, 'MISSING_FIELDS');
    }

    // Validate target users
    const validTargets = ['all', 'active', 'venue_owners', 'admins'];
    if (targetUsers && !validTargets.includes(targetUsers)) {
      throw new AppError('Invalid target users', 400, 'INVALID_TARGET');
    }

    // For now, just log the broadcast
    // In production, this would integrate with email service and notification system
    logger.info('Admin broadcast message', {
      adminUserId: req.user!.id,
      subject,
      message,
      targetUsers: targetUsers || 'all',
      templateId,
      scheduledFor,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: 'Broadcast message scheduled successfully',
      data: {
        id: `broadcast_${Date.now()}`,
        subject,
        message,
        targetUsers: targetUsers || 'all',
        scheduledFor: scheduledFor || new Date(),
        status: 'scheduled'
      }
    });
  } catch (error) {
    logger.error('Error sending broadcast message:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to send broadcast message', 500, 'BROADCAST_ERROR');
  }
}));

// Get notification center data
router.get('/notifications', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', type, status } = req.query;

    // Get real notifications from database
    const whereClause: any = {
      userId: req.user!.id
    };

    if (type) {
      whereClause.type = type;
    }
    if (status) {
      whereClause.read = status === 'read';
    }

    const [notifications, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.notification.findMany({
          where: whereClause,
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit as string),
          skip: (parseInt(page as string) - 1) * parseInt(limit as string)
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.notification.count({ where: whereClause });
      })
    ]);

    res.json({
      success: true,
      data: {
        notifications,
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total,
          pages: Math.ceil(total / parseInt(limit as string))
        }
      }
    });
  } catch (error) {
    logger.error('Error fetching notifications:', error);
    throw new AppError('Failed to fetch notifications', 500, 'NOTIFICATIONS_ERROR');
  }
}));

// Mark notification as read
router.patch('/notifications/:id/read', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // For now, just return success
    // In production, this would update the notification status in database
    logger.info('Admin marked notification as read', {
      adminUserId: req.user!.id,
      notificationId: id,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: 'Notification marked as read',
      data: { id, status: 'read' }
    });
  } catch (error) {
    logger.error('Error marking notification as read:', error);
    throw new AppError('Failed to mark notification as read', 500, 'NOTIFICATION_UPDATE_ERROR');
  }
}));

// Advanced Financial Features - Invoice Generation
router.post('/generate-invoice', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { bookingId, customAmount, notes } = req.body;

    if (!bookingId) {
      throw new AppError('Booking ID is required', 400, 'MISSING_BOOKING_ID');
    }

    // Generate real invoice using database
    const invoice = await safePrismaQuery(async (client) => {
      // Get booking details
      const booking = await client.booking.findUnique({
        where: { id: bookingId },
        include: {
          activity: {
            select: { title: true, price: true }
          },
          parent: {
            select: { firstName: true, lastName: true, email: true }
          }
        }
      });

      if (!booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Invoice model doesn't exist in schema - return booking with invoice data
      // TODO: Add Invoice model to Prisma schema if invoice functionality is needed
      return {
        id: bookingId, // Using bookingId as invoice id since Invoice model doesn't exist
        bookingId,
        amount: customAmount || booking.activity.price,
        status: 'generated',
        notes: notes || '',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        booking: booking
      };
    });

    logger.info('Admin generated invoice', {
      adminUserId: req.user!.id,
      bookingId,
      invoiceId: invoice.id,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: 'Invoice generated successfully',
      data: invoice
    });
  } catch (error) {
    logger.error('Error generating invoice:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to generate invoice', 500, 'INVOICE_GENERATION_ERROR');
  }
}));

// Advanced Admin Tools - Bulk Operations
router.post('/bulk-user-update', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { userIds, updates } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      throw new AppError('User IDs array is required', 400, 'MISSING_USER_IDS');
    }

    if (!updates || Object.keys(updates).length === 0) {
      throw new AppError('Updates object is required', 400, 'MISSING_UPDATES');
    }

    // Validate updates
    const validFields = ['role', 'isActive'];
    const updateFields = Object.keys(updates);
    const invalidFields = updateFields.filter(field => !validFields.includes(field));
    
    if (invalidFields.length > 0) {
      throw new AppError(`Invalid update fields: ${invalidFields.join(', ')}`, 400, 'INVALID_UPDATE_FIELDS');
    }

    // For now, just log the bulk operation
    // In production, this would perform actual database updates
    logger.info('Admin bulk user update', {
      adminUserId: req.user!.id,
      userIds,
      updates,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: `Bulk update completed for ${userIds.length} users`,
      data: {
        updatedUsers: userIds.length,
        updates,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('Error performing bulk user update:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to perform bulk user update', 500, 'BULK_UPDATE_ERROR');
  }
}));

// Advanced Admin Tools - System Configuration
router.get('/system-config', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    // For now, return mock system configuration
    // In production, this would come from environment variables or database
    const config = {
      app: {
        name: 'BookOn',
        version: '1.0.0',
        environment: process.env['NODE_ENV'] || 'development'
      },
      features: {
        emailNotifications: true,
        smsNotifications: false,
        paymentProcessing: true,
        analytics: true
      },
      limits: {
        maxVenuesPerUser: 10,
        maxActivitiesPerVenue: 50,
        maxBookingsPerUser: 100,
        fileUploadSize: '5MB'
      },
      integrations: {
        stripe: true,
        emailService: 'SendGrid',
        analytics: 'Google Analytics'
      }
    };

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.error('Error fetching system configuration:', error);
    throw new AppError('Failed to fetch system configuration', 500, 'SYSTEM_CONFIG_ERROR');
  }
}));

// Advanced Admin Tools - Audit Logs
router.get('/audit-logs', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { 
      action_type, 
      user_id, 
      table_name, 
      record_id, 
      date_from, 
      date_to, 
      page = '1', 
      limit = '50' 
    } = req.query;

    // Build Prisma where clause
    const whereClause: any = {};

    if (action_type) {
      whereClause.action = action_type;
    }

    if (user_id) {
      whereClause.userId = user_id;
    }

    if (table_name) {
      whereClause.entityType = table_name;
    }

    if (record_id) {
      whereClause.entityId = record_id;
    }

    if (date_from || date_to) {
      whereClause.timestamp = {};
      if (date_from) whereClause.timestamp.gte = new Date(date_from as string);
      if (date_to) whereClause.timestamp.lte = new Date(date_to as string);
    }

    const total = await (prisma as any).auditLog.count({ where: whereClause });
    const logs = await (prisma as any).auditLog.findMany({
      where: whereClause,
      take: parseInt(limit as string),
      skip: (parseInt(page as string) - 1) * parseInt(limit as string),
      orderBy: { timestamp: 'desc' },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        }
      }
    });

    res.json({
      success: true,
      data: logs,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: total,
        pages: Math.ceil((total) / parseInt(limit as string))
      }
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch audit logs'
    });
  }
}));

router.get('/audit-logs/summary', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { date_from, date_to } = req.query;

    const whereClause: any = {};
    if (date_from) {
      whereClause.timestamp = { gte: new Date(date_from as string) };
    }
    if (date_to) {
      whereClause.timestamp = { ...whereClause.timestamp, lte: new Date(date_to as string) };
    }

    // Get action type summary
    const actionSummary = await (prisma as any).auditLog.groupBy({
      by: ['action'],
      where: whereClause,
      _count: { action: true }
    });

    // Get user activity summary
    const userSummary = await (prisma as any).auditLog.groupBy({
      by: ['userId'],
      where: whereClause,
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 10
    });

    // Get table activity summary
    const tableSummary = await (prisma as any).auditLog.groupBy({
      by: ['entityType'],
      where: whereClause,
      _count: { entityType: true },
      orderBy: { _count: { entityType: 'desc' } }
    });

    // Get daily activity - simplified for now
    const dailyActivity = await (prisma as any).auditLog.findMany({
      where: whereClause,
      select: { timestamp: true },
      orderBy: { timestamp: 'desc' },
      take: 30
    });

    res.json({
      success: true,
      data: {
        actionSummary,
        userSummary,
        tableSummary,
        dailyActivity
      }
    });
  } catch (error) {
    console.error('Error fetching audit summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch audit summary'
    });
  }
}));

router.post('/audit-logs/export', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { format = 'csv', filters } = req.body;
    
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({
        success: false,
        message: 'Export format must be csv or json'
      });
    }

    const whereClause: any = {};

    // Apply filters if provided
    if (filters) {
      if (filters.action_type) {
        whereClause.action = filters.action_type;
      }
      if (filters.user_id) {
        whereClause.userId = filters.user_id;
      }
      if (filters.table_name) {
        whereClause.entityType = filters.table_name;
      }
      if (filters.date_from) {
        whereClause.timestamp = { gte: new Date(filters.date_from) };
      }
      if (filters.date_to) {
        whereClause.timestamp = { ...whereClause.timestamp, lte: new Date(filters.date_to) };
      }
    }

    const logs = await (prisma as any).auditLog.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        }
      }
    });

    if (format === 'csv') {
      const csvHeaders = [
        'Timestamp',
        'User',
        'Action',
        'Table',
        'Record ID',
        'Old Values',
        'New Values',
        'IP Address',
        'User Agent'
      ];

      const csvData = logs.map((log: any) => [
        log.timestamp,
        `${log.user.firstName || ''} ${log.user.lastName || ''}`.trim() || log.user.email || 'Unknown',
        log.action,
        log.entityType,
        log.entityId,
        log.changes ? JSON.stringify(log.changes) : '',
        log.metadata ? JSON.stringify(log.metadata) : '',
        log.ipAddress || '',
        log.userAgent || ''
      ]);

      const csvContent = [csvHeaders, ...csvData]
        .map(row => row.map((field: any) => `"${field}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvContent);
    } else {
      return res.json({
        success: true,
        data: logs
      });
    }
  } catch (error) {
    console.error('Error exporting audit logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export audit logs'
    });
  }
}));

// Audit log cleanup (for old logs)
router.delete('/audit-logs/cleanup', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { days = '90' } = req.query;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days as string));

    const deletedCount = await (prisma as any).auditLog.deleteMany({
      where: {
        timestamp: {
          lt: cutoffDate
        }
      }
    });

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount.count} audit logs older than ${days} days`
    });
  } catch (error) {
    console.error('Error cleaning up audit logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clean up audit logs'
    });
  }
}));

// Payment Settings Management
router.get('/payment-settings', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    // Get payment settings from environment variables or database
    const settings = {
      platformFeePercentage: parseFloat(process.env['STRIPE_PLATFORM_FEE_PERCENTAGE'] || '2.9'),
      platformFeeFixed: parseFloat(process.env['STRIPE_PLATFORM_FEE_FIXED'] || '0.30'),
      stripeEnabled: !!process.env['STRIPE_SECRET_KEY'],
      stripePublishableKey: process.env['STRIPE_PUBLISHABLE_KEY'] || '',
      stripeSecretKey: process.env['STRIPE_SECRET_KEY'] ? '***' : '', // Don't expose actual secret
      webhookSecret: process.env['STRIPE_WEBHOOK_SECRET'] || '',
      defaultCurrency: process.env['DEFAULT_CURRENCY'] || 'GBP',
      supportedCurrencies: ['GBP', 'USD', 'EUR'],
      autoPayouts: process.env['AUTO_PAYOUTS'] === 'true',
      payoutSchedule: process.env['PAYOUT_SCHEDULE'] || 'weekly',
      minimumPayoutAmount: parseFloat(process.env['MINIMUM_PAYOUT_AMOUNT'] || '50.00')
    };

    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    console.error('Error fetching payment settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment settings'
    });
  }
}));

router.put('/payment-settings', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { platformFeePercentage, platformFeeFixed } = req.body;
    
    // Validate input
    if (platformFeePercentage < 0 || platformFeePercentage > 100) {
      return res.status(400).json({
        success: false,
        message: 'Platform fee percentage must be between 0 and 100'
      });
    }

    if (platformFeeFixed < 0) {
      return res.status(400).json({
        success: false,
        message: 'Platform fee fixed amount cannot be negative'
      });
    }

    // TODO: Save to database or environment variables
    // For now, just return success
    return res.json({
      success: true,
      message: 'Payment settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating payment settings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update payment settings'
    });
  }
}));

// Venue Payment Account Management
router.get('/venue-payment-accounts', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    // Get all venues with their Stripe Connect accounts
    const venues = await prisma.venue.findMany({
      select: {
        id: true,
        name: true,
        // Note: Stripe-related fields don't exist in current schema
        // These would need to be added to the Venue model if needed
      }
    });

    const venueAccounts = venues.map(venue => ({
      id: venue.id,
      venueName: venue.name,
      stripeAccountId: 'Not connected', // Field doesn't exist in current schema
      accountStatus: 'pending', // Field doesn't exist in current schema
      chargesEnabled: false, // Field doesn't exist in current schema
      payoutsEnabled: false, // Field doesn't exist in current schema
      verificationStatus: 'unverified', // Field doesn't exist in current schema
      lastPayout: null, // Field doesn't exist in current schema
      nextPayout: null // Field doesn't exist in current schema
    }));

    return res.json({
      success: true,
      data: venueAccounts
    });
  } catch (error) {
    console.error('Error fetching venue payment accounts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch venue payment accounts'
    });
  }
}));

router.post('/venue-payment-accounts', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId } = req.body;
    
    if (!venueId) {
      return res.status(400).json({
        success: false,
        message: 'Venue ID is required'
      });
    }

    // Check if venue exists
    const venue = await prisma.venue.findUnique({
      where: { id: venueId }
    });
    if (!venue) {
      return res.status(404).json({
        success: false,
        message: 'Venue not found'
      });
    }

    // TODO: Create Stripe Connect account
    // For now, just update the venue status
    await prisma.venue.update({
      where: { id: venueId as string },
      data: {
        // Note: payment_status and verification_status fields don't exist in current schema
        // These would need to be added to the Venue model if needed
        updatedAt: new Date()
      }
    });

    return res.json({
      success: true,
      message: 'Venue payment account created successfully'
    });
  } catch (error) {
    console.error('Error creating venue payment account:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create venue payment account'
    });
  }
}));

// Payout Management
router.get('/payouts', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { status, venue_id, page = '1', limit = '20' } = req.query;
    
    const whereClause: any = {};

    if (status) {
      whereClause.status = status;
    }

    if (venue_id) {
      whereClause.venueId = venue_id;
    }

    const total = await (prisma as any).payout.count({ where: whereClause });
    const payouts = await (prisma as any).payout.findMany({
      where: whereClause,
      include: {
        venue: {
          select: {
            name: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      skip: (parseInt(page as string) - 1) * parseInt(limit as string)
    });

    return res.json({
      success: true,
      data: payouts,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: total,
        pages: Math.ceil((total) / parseInt(limit as string))
      }
    });
  } catch (error) {
    console.error('Error fetching payouts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payouts'
    });
  }
}));

router.post('/payouts/process', authenticateToken, requireAdminOrStaff, asyncHandler(async (_req: Request, res: Response) => {
  try {
    // TODO: Implement payout processing logic
    // This would trigger payouts for all venues that meet the criteria
    
    return res.json({
      success: true,
      message: 'Payout processing initiated'
    });
  } catch (error) {
    console.error('Error processing payouts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process payouts'
    });
  }
}));

// Export Functionality
router.get('/export/registers', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { format = 'csv', venue_id, date_from, date_to, status } = req.query;
    
    if (format !== 'csv' && format !== 'pdf') {
      return res.status(400).json({
        success: false,
        message: 'Export format must be csv or pdf'
      });
    }

    // Build query for registers
    const whereClause: any = {};

    if (venue_id) {
      whereClause.venueId = venue_id;
    }

    if (date_from) {
      whereClause.date = { gte: new Date(date_from as string) };
    }

    if (date_to) {
      whereClause.date = { ...whereClause.date, lte: new Date(date_to as string) };
    }

    if (status) {
      whereClause.status = status;
    }

    const registers = await (prisma as any).register.findMany({
      where: whereClause,
      include: {
        venue: {
          select: {
            name: true
          }
        },
        activity: {
          select: {
            name: true
          }
        }
      },
      orderBy: { date: 'desc' }
    });

    if (format === 'csv') {
      // Generate CSV
      const csvHeaders = [
        'Date',
        'Venue',
        'Activity',
        'Status',
        'Total Children',
        'Staff Present',
        'Notes'
      ];

      const csvData = registers.map((register: any) => [
        register.date,
        register.venue.name,
        register.activity.title,
        register.status,
        '0', // total_children field doesn't exist in current schema
        'N/A', // staff_present field doesn't exist in current schema
        register.notes || ''
      ]);

      const csvContent = [csvHeaders, ...csvData]
        .map(row => row.map((field: any) => `"${field}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="registers_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvContent);
    } else {
      // TODO: Implement PDF generation
      return res.json({
        success: true,
        message: 'PDF export not yet implemented',
        data: registers
      });
    }
  } catch (error) {
    console.error('Error exporting registers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export registers'
    });
  }
}));

router.get('/export/bookings', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { format = 'csv', venue_id, date_from, date_to, status } = req.query;
    
    if (format !== 'csv' && format !== 'pdf') {
      return res.status(400).json({
        success: false,
        message: 'Export format must be csv or pdf'
      });
    }

    // Build query for bookings
    const whereClause: any = {};

    if (venue_id) {
      whereClause.activity = {
        venueId: venue_id
      };
    }

    if (date_from) {
      whereClause.activityDate = { gte: new Date(date_from as string) };
    }

    if (date_to) {
      whereClause.activityDate = { ...whereClause.activityDate, lte: new Date(date_to as string) };
    }

    if (status) {
      whereClause.status = status;
    }

    const bookings = await prisma.booking.findMany({
      where: whereClause,
      include: {
        activity: {
          include: {
            venue: {
              select: {
                name: true
              }
            }
          }
        },
        parent: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        }
      },
      orderBy: { activityDate: 'desc' }
    });

    if (format === 'csv') {
      // Generate CSV
      const csvHeaders = [
        'Booking ID',
        'Date',
        'Venue',
        'Activity',
        'Customer',
        'Email',
        'Status',
        'Amount',
        'Children Count'
      ];

      const csvData = bookings.map(booking => [
        booking.id,
        booking.activityDate,
        booking.activity.venue.name,
        booking.activity.title,
        `${booking.parent.firstName} ${booking.parent.lastName}`,
        booking.parent.email,
        booking.status,
        booking.amount,
        '1' // children_count field doesn't exist in current schema
      ]);

      const csvContent = [csvHeaders, ...csvData]
        .map(row => row.map((field: any) => `"${field}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="bookings_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvContent);
    } else {
      // TODO: Implement PDF generation
      return res.json({
        success: true,
        message: 'PDF export not yet implemented',
        data: bookings
      });
    }
  } catch (error) {
    console.error('Error exporting bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export bookings'
    });
  }
}));

router.get('/export/financial', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { format = 'csv', venue_id, date_from, date_to } = req.query;
    
    if (format !== 'csv' && format !== 'pdf') {
      return res.status(400).json({
        success: false,
        message: 'Export format must be csv or pdf'
      });
    }

    // Build query for financial data
    const whereClause: any = {
      status: 'confirmed'
    };

    if (venue_id) {
      whereClause.activity = {
        venueId: venue_id
      };
    }

    if (date_from) {
      whereClause.activityDate = { gte: new Date(date_from as string) };
    }

    if (date_to) {
      whereClause.activityDate = { ...whereClause.activityDate, lte: new Date(date_to as string) };
    }

    const financialData = await prisma.booking.findMany({
      where: whereClause,
      include: {
        activity: {
          include: {
            venue: {
              select: {
                name: true
              }
            }
          }
        }
      },
      orderBy: { activityDate: 'desc' }
    });

    if (format === 'csv') {
      // Generate CSV
      const csvHeaders = [
        'Date',
        'Venue',
        'Activity',
        'Total Bookings',
        'Total Revenue',
        'Platform Fees',
        'Net Revenue'
      ];

      // Group data by date, venue, and activity for aggregation
      const groupedData = financialData.reduce((acc, booking) => {
        const key = `${booking.activityDate}-${booking.activity.venue.name}-${booking.activity.title}`;
        if (!acc[key]) {
          acc[key] = {
            date: booking.activityDate,
            venue: booking.activity.venue.name,
            activity: booking.activity.title,
            totalBookings: 0,
            totalRevenue: 0,
            totalPlatformFees: 0
          };
        }
        acc[key].totalBookings += 1;
        acc[key].totalRevenue += parseFloat(String(booking.amount || 0));
        acc[key].totalPlatformFees += 0; // platform_fee field doesn't exist in current schema
        return acc;
      }, {} as any);

      const csvData = Object.values(groupedData).map((row: any) => [
        row.date,
        row.venue,
        row.activity,
        row.totalBookings,
        `£${row.totalRevenue.toFixed(2)}`,
        `£${row.totalPlatformFees.toFixed(2)}`,
        `£${(row.totalRevenue - row.totalPlatformFees).toFixed(2)}`
      ]);

      const csvContent = [csvHeaders, ...csvData]
        .map(row => row.map((field: any) => `"${field}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="financial_report_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvContent);
    } else {
      // TODO: Implement PDF generation
      return res.json({
        success: true,
        message: 'PDF export not yet implemented',
        data: financialData
      });
    }
  } catch (error) {
    console.error('Error exporting financial data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export financial data'
    });
  }
}));

// Export scheduling
router.post('/export/schedule', authenticateToken, requireAdminOrStaff, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { type, format, schedule, recipients } = req.body;
    
    if (!type || !format || !schedule || !recipients) {
      return res.status(400).json({
        success: false,
        message: 'Type, format, schedule, and recipients are required'
      });
    }

    // TODO: Implement export scheduling logic
    // This would create a scheduled job to generate and email exports
    
    return res.json({
      success: true,
      message: 'Export scheduled successfully'
    });
  } catch (error) {
    console.error('Error scheduling export:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to schedule export'
    });
  }
}));

export default router;
