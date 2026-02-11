import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const router = Router();

// Get widget configuration and data
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId, activityId, theme = 'light', primaryColor = '#00806a' } = req.query;

    if (!venueId && !activityId) {
      throw new AppError('Venue ID or Activity ID is required', 400, 'MISSING_PARAMETERS');
    }

    let widgetData: any = {};

    if (venueId) {
      // Get venue-specific data
      const venue = await prisma.venue.findFirst({
        where: { 
          id: venueId as string,
          isActive: true
        }
      });

      if (!venue) {
        throw new AppError('Venue not found or inactive', 404, 'VENUE_NOT_FOUND');
      }

      // Get activities for this venue
      const activities = await prisma.activity.findMany({
        where: { 
          venueId: venueId as string,
          isActive: true
        },
        orderBy: { createdAt: 'desc' }
      });

      widgetData = {
        venue,
        activities,
        type: 'venue'
      };
    }

    if (activityId) {
      // Get activity-specific data
      const activity = await prisma.activity.findFirst({
        where: { 
          id: activityId as string,
          isActive: true
        },
        include: {
          venue: {
            select: {
              name: true,
              address: true,
              city: true
            }
          }
        }
      });

      if (!activity) {
        throw new AppError('Activity not found or inactive', 404, 'ACTIVITY_NOT_FOUND');
      }

      widgetData = {
        activity,
        type: 'activity'
      };
    }

    // Build widget configuration
    const widgetConfig = {
      theme,
      primaryColor,
      position: 'bottom-right',
      showLogo: true,
      customCSS: '',
      data: widgetData
    };

    // Log widget access
    logger.info('Widget data requested', {
      venueId,
      activityId,
      theme,
      userAgent: req.get('User-Agent') || null,
      ip: req.ip
    });

    res.json({
      success: true,
      data: widgetConfig
    });
  } catch (error) {
    logger.error('Error fetching widget data:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch widget data', 500, 'WIDGET_FETCH_ERROR');
  }
}));

// Get specific activity data for widget
router.get('/activity/:id', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new AppError('Activity ID is required', 400, 'MISSING_ACTIVITY_ID');
    }

    const activity = await prisma.activity.findFirst({
      where: { 
        id: id,
        isActive: true
      },
      include: {
        venue: {
          select: {
            name: true,
            address: true,
            city: true,
            postcode: true
          }
        }
      }
    });

    if (!activity) {
      throw new AppError('Activity not found or inactive', 404, 'ACTIVITY_NOT_FOUND');
    }

    // Get current booking count for this activity (only confirmed bookings count towards capacity)
    const bookingCount = await prisma.booking.count({
      where: {
        activityId: id as string,
        status: 'confirmed'
      }
    });

    const activityData = {
      id: activity.id,
      title: activity.title,
      description: activity.description,
      startDate: activity.createdAt, // Using createdAt as placeholder
      startTime: activity.createdAt, // Using createdAt as placeholder
      endTime: activity.createdAt, // Using createdAt as placeholder
      price: 0, // Default price
      currency: 'GBP',
      capacity: activity.capacity,
      bookedCount: bookingCount,
      venue: {
        id: activity.venueId,
        name: 'Venue Name', // Placeholder
        address: 'Venue Address', // Placeholder
        city: 'City', // Placeholder
        postcode: 'Postcode' // Placeholder
      }
    };

    res.json({
      success: true,
      data: activityData
    });
  } catch (error) {
    logger.error('Error fetching activity for widget:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch activity data', 500, 'ACTIVITY_FETCH_ERROR');
  }
}));

// Widget analytics tracking endpoint
router.post('/analytics', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { eventType, widgetId, venueId, activityId, timestamp, data } = req.body;

    if (!eventType) {
      throw new AppError('Event type is required', 400, 'MISSING_EVENT_TYPE');
    }

    // Store analytics data
    await prisma.widgetAnalytics.create({
      data: {
        eventType: eventType,
        widgetId: widgetId || 'default',
        venueId: venueId,
        activityId: activityId as string,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        eventData: data || {},
        userAgent: req.get('User-Agent') || null,
        ipAddress: req.ip || null
      }
    });

    // Log analytics event
    logger.info('Widget analytics event tracked', {
      eventType,
      widgetId,
      venueId,
      activityId,
      data
    });

    res.json({
      success: true,
      message: 'Analytics event tracked successfully'
    });
  } catch (error) {
    logger.error('Error tracking widget analytics:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to track analytics event', 500, 'ANALYTICS_TRACKING_ERROR');
  }
}));

// Get widget analytics summary
router.get('/analytics/summary', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId, activityId, dateFrom, dateTo, eventType } = req.query;

    // Build Prisma where clause
    const whereClause: any = {};
    if (venueId) whereClause.venueId = venueId;
    if (activityId) whereClause.activityId = activityId;
    if (eventType) whereClause.eventType = eventType;
    if (dateFrom) whereClause.timestamp = { gte: new Date(dateFrom as string) };
    if (dateTo) whereClause.timestamp = { ...whereClause.timestamp, lte: new Date(dateTo as string) };

    const analytics = await prisma.widgetAnalytics.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: 100
    });

    // Group by event type for summary
    const eventSummary = analytics.reduce((acc: any, event: any) => {
      const type = event.eventType;
      if (!acc[type]) {
        acc[type] = { count: 0, events: [] };
      }
      acc[type].count++;
      acc[type].events.push(event);
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totalEvents: analytics.length,
        eventSummary,
        recentEvents: analytics.slice(0, 20)
      }
    });
  } catch (error) {
    logger.error('Error fetching widget analytics summary:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch analytics summary', 500, 'ANALYTICS_FETCH_ERROR');
  }
}));

// Get widget performance metrics
router.get('/performance', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { venueId, days = '30' } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days as string));

    const whereClause: any = {
      timestamp: { gte: daysAgo }
    };

    if (venueId) {
      whereClause.venueId = venueId;
    }

    const analytics = await prisma.widgetAnalytics.findMany({
      where: whereClause
    });

    // Calculate metrics
    const totalViews = analytics.filter((e: any) => e.eventType === 'WIDGET_VIEW').length;
    const totalInteractions = analytics.filter((e: any) => e.eventType === 'WIDGET_INTERACTION').length;
    const totalConversions = analytics.filter((e: any) => e.eventType === 'BOOKING_SUCCESS').length;
    const totalErrors = analytics.filter((e: any) => e.eventType === 'BOOKING_ERROR').length;

    const conversionRate = totalViews > 0 ? (totalConversions / totalViews) * 100 : 0;
    const interactionRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;

    // Daily breakdown
    const dailyStats = analytics.reduce((acc: any, event: any) => {
      const date = new Date(event.timestamp).toISOString().split('T')[0];
      if (date && !acc[date]) {
        acc[date] = { views: 0, interactions: 0, conversions: 0, errors: 0 };
      }
      
      if (date) {
        switch (event.event_type) {
          case 'WIDGET_VIEW':
            acc[date].views++;
            break;
          case 'WIDGET_INTERACTION':
            acc[date].interactions++;
            break;
          case 'BOOKING_SUCCESS':
            acc[date].conversions++;
            break;
          case 'BOOKING_ERROR':
            acc[date].errors++;
            break;
        }
      }
      
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        period: `${days} days`,
        totalViews,
        totalInteractions,
        totalConversions,
        totalErrors,
        conversionRate: Math.round(conversionRate * 100) / 100,
        interactionRate: Math.round(interactionRate * 100) / 100,
        dailyStats
      }
    });
  } catch (error) {
    logger.error('Error fetching widget performance:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch performance metrics', 500, 'PERFORMANCE_FETCH_ERROR');
  }
}));

// Handle widget booking submissions
router.post('/book', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { 
      activityId, 
      date, 
      childName, 
      parentEmail, 
      phone, 
      notes,
      source = 'widget',
      widgetId 
    } = req.body;

    // Validate required fields
    if (!activityId || !date || !childName || !parentEmail || !phone) {
      throw new AppError('Missing required fields', 400, 'MISSING_REQUIRED_FIELDS');
    }

    // Validate activity exists and is active
    const activity = await prisma.activity.findFirst({
      where: { 
        id: activityId as string,
        isActive: true
      }
    });

    if (!activity) {
      throw new AppError('Activity not found or inactive', 404, 'ACTIVITY_NOT_FOUND');
    }

    // Check if activity has available capacity
    const currentBookings = await prisma.booking.count({
      where: {
        activityId: activityId as string,
        activityDate: new Date(date),
        status: 'confirmed'
      }
    });

    if (currentBookings >= (activity.capacity || 20)) {
      throw new AppError('Activity is fully booked for this date', 400, 'ACTIVITY_FULL');
    }

    // Create or find user
    let user = await prisma.user.findFirst({
      where: { 
        email: parentEmail,
        isActive: true
      }
    });

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          email: parentEmail,
          password_hash: 'temp_hash_' + Math.random().toString(36).substr(2, 9), // Temporary hash
          role: 'parent',
          isActive: true,
          emailVerified: false,
          firstName: parentEmail.split('@')[0], // Use email prefix as first name
          lastName: 'User' // Default last name
        }
      });

      // Note: user_profiles table doesn't exist in current schema
      // User profile data would need to be added to the User model if needed

      logger.info('New user created from widget', { userId: user.id, email: parentEmail });
    }

    // Create child record
    const child = await prisma.child.create({
      data: {
        parentId: user.id,
        firstName: childName.split(' ')[0] || 'Child',
        lastName: childName.split(' ').slice(1).join(' ') || 'User',
        dateOfBirth: new Date(), // Default date, can be updated later
        // gender: 'other' // Default gender - field doesn't exist in schema
      }
    });

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        parentId: user.id,
        activityId: activityId as string,
        childId: child.id,
        status: 'pending',
        paymentStatus: 'pending',
        amount: 0, // Default amount
        currency: 'GBP',
        bookingDate: new Date(),
        activityDate: new Date(date),
        activityTime: '09:00', // Default time
        notes: notes || `Widget booking from ${source}`,
        paymentMethod: 'card'
      }
    });

    // Log widget analytics
    if (widgetId) {
      try {
        await prisma.widgetAnalytics.create({
          data: {
            eventType: 'BOOKING_CREATED',
            widgetId: widgetId,
            venueId: activity.venueId,
            activityId: activityId as string,
            eventData: {
              source,
              childName,
              parentEmail,
              date,
              amount: 0 // Default amount
            },
            userAgent: req.get('User-Agent') || null,
            ipAddress: req.ip || null || null
          }
        });
      } catch (analyticsError) {
        logger.warn('Failed to log widget analytics', { error: analyticsError, widgetId });
      }
    }

    logger.info('Widget booking created successfully', {
      bookingId: booking.id,
      activityId,
      userId: user.id,
      childId: child.id,
      source,
      widgetId
    });

    res.json({
      success: true,
      message: 'Booking submitted successfully',
      data: {
        bookingId: booking.id,
        status: booking.status,
        nextSteps: [
          'We will review your booking and confirm availability',
          'You will receive a confirmation email shortly',
          'Payment will be processed upon confirmation'
        ]
      }
    });

  } catch (error) {
    logger.error('Error processing widget booking:', error);
    
    // Log widget analytics for failed booking
    if (req.body.widgetId) {
      try {
        await prisma.widgetAnalytics.create({
          data: {
            eventType: 'BOOKING_FAILED',
            widgetId: req.body.widgetId,
            venueId: req.body.venueId,
            activityId: req.body.activityId,
            eventData: {
              error: error instanceof Error ? error.message : 'Unknown error',
              source: req.body.source || 'widget'
            },
            userAgent: req.get('User-Agent') || null,
            ipAddress: req.ip || null || null
          }
        });
      } catch (analyticsError) {
        logger.warn('Failed to log widget analytics', { error: analyticsError });
      }
    }

    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process booking', 500, 'WIDGET_BOOKING_ERROR');
  }
}));

export default router;
