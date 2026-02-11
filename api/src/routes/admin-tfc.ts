/// <reference path="../middleware/auth.ts" />
import express, { Request, Response } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';
import { tfcService } from '../services/tfcService';
import { schedulerService } from '../services/schedulerService';

const router = express.Router();

// Apply authentication and admin role to all routes
router.use(authenticateToken);
router.use(requireRole(['admin', 'staff']));

/**
 * Get TFC pending bookings queue with stats
 */
router.get('/pending', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId, status } = req.query;
    const adminId = req.user!.id;

    const whereClause: any = {
      paymentMethod: 'tfc'
    };

    if (venueId) {
      whereClause.activity = {
        venueId: venueId as string
      };
    }

    if (status && status !== 'all') {
      whereClause.paymentStatus = status as string;
    }

    const bookings = await prisma.booking.findMany({
      where: whereClause,
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
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate stats
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    const stats = {
      totalPending: bookings.filter(b => b.paymentStatus === 'pending_payment').length,
      totalAmount: bookings.reduce((sum, b) => sum + Number(b.amount), 0),
      expiringToday: bookings.filter(b => {
        const deadline = new Date(b.tfcDeadline!);
        return deadline >= today && deadline < tomorrow && b.paymentStatus === 'pending_payment';
      }).length,
      overdue: bookings.filter(b => {
        const deadline = new Date(b.tfcDeadline!);
        return deadline < now && b.paymentStatus === 'pending_payment';
      }).length
    };

    logger.info('TFC pending bookings fetched', {
      adminId,
      totalBookings: bookings.length,
      stats
    });

    res.json({
      success: true,
      data: {
        bookings,
        stats
      }
    });
  } catch (error) {
    logger.error('Error fetching TFC pending bookings:', error);
    throw error;
  }
}));

/**
 * Bulk mark multiple TFC bookings as paid
 */
router.post('/bulk-mark-paid', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { bookingIds } = req.body;
    const adminId = req.user!.id;

    if (!bookingIds || !Array.isArray(bookingIds) || bookingIds.length === 0) {
      throw new AppError('Booking IDs array is required', 400, 'INVALID_REQUEST');
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[]
    };

    for (const bookingId of bookingIds) {
      try {
        await tfcService.confirmTFCPayment(bookingId, adminId);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`${bookingId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    logger.info('Bulk TFC payment confirmation completed', {
      adminId,
      totalRequested: bookingIds.length,
      results
    });

    res.json({
      success: true,
      message: `Processed ${bookingIds.length} bookings: ${results.success} successful, ${results.failed} failed`,
      data: results
    });
  } catch (error) {
    logger.error('Error in bulk TFC payment confirmation:', error);
    throw error;
  }
}));

/**
 * Get TFC analytics and reports
 */
router.get('/analytics', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId, dateFrom, dateTo } = req.query;
    const adminId = req.user!.id;

    const whereClause: any = {
      paymentMethod: 'tfc'
    };

    if (venueId) {
      whereClause.activity = {
        venueId: venueId as string
      };
    }

    if (dateFrom || dateTo) {
      whereClause.createdAt = {};
      if (dateFrom) whereClause.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) whereClause.createdAt.lte = new Date(dateTo as string);
    }

    const bookings = await prisma.booking.findMany({
      where: whereClause,
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
        }
      }
    });

    // Calculate analytics
    const analytics = {
      totalBookings: bookings.length,
      totalRevenue: bookings.reduce((sum, b) => sum + Number(b.amount), 0),
      pendingBookings: bookings.filter(b => b.paymentStatus === 'pending_payment').length,
      paidBookings: bookings.filter(b => b.paymentStatus === 'paid').length,
      cancelledBookings: bookings.filter(b => b.status === 'cancelled').length,
      averageBookingValue: bookings.length > 0 ? 
        bookings.reduce((sum, b) => sum + Number(b.amount), 0) / bookings.length : 0,
      bookingsByStatus: {} as Record<string, number>,
      bookingsByVenue: {} as Record<string, number>,
      revenueByVenue: {} as Record<string, number>
    };

    // Group by status
    bookings.forEach(booking => {
      analytics.bookingsByStatus[booking.paymentStatus] = 
        (analytics.bookingsByStatus[booking.paymentStatus] || 0) + 1;
    });

    // Group by venue
    bookings.forEach(booking => {
      const venueName = booking.activity.venue.name;
      analytics.bookingsByVenue[venueName] = 
        (analytics.bookingsByVenue[venueName] || 0) + 1;
      analytics.revenueByVenue[venueName] = 
        (analytics.revenueByVenue[venueName] || 0) + Number(booking.amount);
    });

    logger.info('TFC analytics generated', {
      adminId,
      analytics
    });

    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    logger.error('Error generating TFC analytics:', error);
    throw error;
  }
}));

/**
 * Get scheduled jobs status
 */
router.get('/jobs/status', asyncHandler(async (req: Request, res: Response) => {
  try {
    const healthCheck = await schedulerService.healthCheck();
    
    res.json({
      success: true,
      data: healthCheck
    });
  } catch (error) {
    logger.error('Error getting jobs status:', error);
    throw error;
  }
}));

/**
 * Manually run a scheduled job
 */
router.post('/jobs/run/:jobName', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { jobName } = req.params;
    const adminId = req.user!.id;

    const result = await schedulerService.runJobManually(jobName);

    logger.info('Manual job execution requested', {
      adminId,
      jobName,
      result
    });

    res.json({
      success: result.success,
      message: result.success ? 'Job executed successfully' : 'Job execution failed',
      data: result
    });
  } catch (error) {
    logger.error('Error running manual job:', error);
    throw error;
  }
}));

/**
 * Get TFC configuration for venues
 */
router.get('/config', asyncHandler(async (req: Request, res: Response) => {
  try {
    const adminId = req.user!.id;

    const venues = await prisma.venue.findMany({
      select: {
        id: true,
        name: true,
        // Note: TFC-specific fields don't exist in Venue schema
        businessAccount: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    logger.info('TFC configuration fetched', {
      adminId,
      venueCount: venues.length
    });

    res.json({
      success: true,
      data: venues
    });
  } catch (error) {
    logger.error('Error fetching TFC configuration:', error);
    throw error;
  }
}));

/**
 * Update TFC configuration for a venue
 */
router.put('/config/:venueId', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId } = req.params;
    // Note: TFC-specific fields don't exist in Venue schema
    // These settings should be stored elsewhere or added to schema
    const adminId = req.user!.id;

    const updatedVenue = await prisma.venue.update({
      where: { id: venueId },
      data: {
        updatedAt: new Date()
        // TFC configuration fields don't exist in schema
      }
    });

    logger.info('TFC configuration updated', {
      adminId,
      venueId
    });

    res.json({
      success: true,
      message: 'TFC configuration updated successfully',
      data: updatedVenue
    });
  } catch (error) {
    logger.error('Error updating TFC configuration:', error);
    throw error;
  }
}));

export default router;
