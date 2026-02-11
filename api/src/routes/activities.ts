import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken, requireRole, optionalAuth } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';
import { activityService } from '../services/activityService';

const router = Router();

// Get all activities
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '20',
      search,
      // type, // Field doesn't exist in Activity model
      venueId,
      status,
      dateFrom,
      dateTo
    } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } }
      ];
    }
    
    // Note: type field doesn't exist in Activity model
    if (venueId) where.venueId = venueId;
    if (status) where.status = status;
    
    if (dateFrom || dateTo) {
      where.startDate = {};
      if (dateFrom) where.startDate.gte = new Date(dateFrom as string);
      if (dateTo) where.startDate.lte = new Date(dateTo as string);
    }

    const [activities, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.activity.findMany({
          where,
          include: {
            venue: {
              select: { name: true, city: true, address: true }
            },
            _count: {
              select: { bookings: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.activity.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: activities,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching activities:', error);
    throw new AppError('Failed to fetch activities', 500, 'ACTIVITIES_FETCH_ERROR');
  }
}));

// Get single activity (public - no auth required for viewing)
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError('Activity ID is required', 400, 'MISSING_ACTIVITY_ID');
    }

    const activity = await safePrismaQuery(async (client) => {
      return await client.activity.findUnique({
        where: { id },
        include: {
          venue: {
            select: { 
              name: true, 
              city: true, 
              address: true,
              capacity: true,
              phone: true,
              email: true
            }
          },
          bookings: {
            include: {
              child: {
                select: { firstName: true, lastName: true, yearGroup: true }
              },
              parent: {
                select: { firstName: true, lastName: true, email: true }
              }
            },
            orderBy: { createdAt: 'desc' }
          },
          registers: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });
    });

    if (!activity) {
      throw new AppError('Activity not found', 404, 'ACTIVITY_NOT_FOUND');
    }

    res.json({
      success: true,
      data: activity
    });
  } catch (error) {
    logger.error('Error fetching activity:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch activity', 500, 'ACTIVITY_FETCH_ERROR');
  }
}));

// Create new activity
router.post('/', authenticateToken, requireRole(['admin', 'coordinator']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      title,
      type,
      activityTypeId,
      venueId,
      description,
      startDate,
      endDate,
      startTime,
      endTime,
      capacity,
      price,
      status
    } = req.body;

    // Validate required fields
    if (!title || !venueId || !startDate || !endDate || !startTime || !endTime || !capacity || price === undefined) {
      throw new AppError('Missing required fields', 400, 'MISSING_REQUIRED_FIELDS');
    }

    // Validate venue exists
    const venue = await safePrismaQuery(async (client) => {
      return await client.venue.findUnique({
        where: { id: venueId }
      });
    });

    if (!venue) {
      throw new AppError('Venue not found', 404, 'VENUE_NOT_FOUND');
    }

    // Create activity using the service
    const activity = await activityService.createActivity({
      title,
      type,
      activityTypeId,
      venueId,
      ownerId: req.user!.id,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      startTime,
      endTime,
      capacity: parseInt(capacity),
      price: parseFloat(price),
      status: status || 'active'
    });

    logger.info('Activity created', {
      activityId: activity.id,
      title: activity.title,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Activity created successfully',
      data: activity
    });
  } catch (error) {
    logger.error('Error creating activity:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to create activity', 500, 'ACTIVITY_CREATE_ERROR');
  }
}));

// Update activity
router.put('/:id', authenticateToken, requireRole(['admin', 'coordinator']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      title,
      type,
      venueId,
      description,
      startDate,
      endDate,
      startTime,
      endTime,
      capacity,
      price,
      earlyDropoff,
      earlyDropoffPrice,
      latePickup,
      latePickupPrice,
      status
    } = req.body;

    if (!id) {
      throw new AppError('Activity ID is required', 400, 'MISSING_ACTIVITY_ID');
    }

    const activity = await safePrismaQuery(async (client) => {
      return await client.activity.update({
        where: { id },
        data: {
          ...(title && { title }),
          ...(type && { type }),
          ...(venueId && { venueId }),
          ...(description !== undefined && { description }),
          ...(startDate && { startDate: new Date(startDate) }),
          ...(endDate && { endDate: new Date(endDate) }),
          ...(startTime && { startTime }),
          ...(endTime && { endTime }),
          ...(capacity !== undefined && { capacity: capacity ? parseInt(capacity) : null }),
          ...(price !== undefined && { price: parseFloat(price) }),
          ...(earlyDropoff !== undefined && { earlyDropoff }),
          ...(earlyDropoffPrice !== undefined && { earlyDropoffPrice: earlyDropoffPrice ? parseFloat(earlyDropoffPrice) : null }),
          ...(latePickup !== undefined && { latePickup }),
          ...(latePickupPrice !== undefined && { latePickupPrice: latePickupPrice ? parseFloat(latePickupPrice) : null }),
          ...(status && { status })
        },
        include: {
          venue: {
            select: { name: true, city: true, address: true }
          }
        }
      });
    });

    logger.info('Activity updated', {
      activityId: activity.id,
      title: activity.title,
      updatedBy: req.user!.id
    });

    res.json({
      success: true,
      message: 'Activity updated successfully',
      data: activity
    });
  } catch (error: any) {
    logger.error('Error updating activity:', error);
    if (error.code === 'P2025') {
      throw new AppError('Activity not found', 404, 'ACTIVITY_NOT_FOUND');
    }
    throw new AppError('Failed to update activity', 500, 'ACTIVITY_UPDATE_ERROR');
  }
}));

// Delete activity
router.delete('/:id', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError('Activity ID is required', 400, 'MISSING_ACTIVITY_ID');
    }

    await safePrismaQuery(async (client) => {
      return await client.activity.delete({
        where: { id }
      });
    });

    logger.info('Activity deleted', {
      activityId: id,
      deletedBy: req.user!.id
    });

    res.json({
      success: true,
      message: 'Activity deleted successfully'
    });
  } catch (error: any) {
    logger.error('Error deleting activity:', error);
    if (error.code === 'P2025') {
      throw new AppError('Activity not found', 404, 'ACTIVITY_NOT_FOUND');
    }
    throw new AppError('Failed to delete activity', 500, 'ACTIVITY_DELETE_ERROR');
  }
}));

// Get upcoming activities
router.get('/upcoming', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { limit = '5' } = req.query;

    const activities = await safePrismaQuery(async (client) => {
      return await client.activity.findMany({
        where: {
          isActive: true,
          startDate: {
            gte: new Date() // Only future activities
          }
        },
        include: {
          venue: {
            select: {
              name: true,
              city: true
            }
          }
        },
        orderBy: { startDate: 'asc' },
        take: parseInt(limit as string)
      });
    });

    res.json({
      success: true,
      data: activities.map(activity => ({
        id: activity.id,
        name: activity.title,
        startDate: activity.startDate,
        endDate: activity.endDate,
        startTime: activity.startTime,
        endTime: activity.endTime,
        venue: activity.venue.name,
        capacity: activity.capacity,
        price: parseFloat(activity.price.toString()),
        status: activity.status
      }))
    });
  } catch (error) {
    logger.error('Error fetching upcoming activities:', error);
    throw new AppError('Failed to fetch upcoming activities', 500, 'UPCOMING_ACTIVITIES_ERROR');
  }
}));


// Get upcoming activities
router.get('/upcoming', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { limit = '5' } = req.query;
    const userId = req.user!.id;
    
    logger.info('Upcoming activities requested', { 
      user: req.user?.email,
      limit,
      userId 
    });

    const upcomingActivities = await safePrismaQuery(async () => {
      const now = new Date();
      
      const activities = await prisma.activity.findMany({
        where: {
          startDate: { gte: now },
          status: 'active'
        },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              address: true
            }
          },
          bookings: {
            select: {
              id: true,
              status: true
            }
          }
        },
        orderBy: {
          startDate: 'asc'
        },
        take: parseInt(limit as string) || 5
      });

      return activities.map(activity => ({
        id: activity.id,
        name: activity.title,
        description: activity.description,
        startTime: activity.startDate,
        endTime: activity.endDate,
        capacity: activity.capacity,
        currentBookings: activity.bookings.filter((b: any) => b.status === 'confirmed').length,
        venue: activity.venue,
        status: activity.status
      }));
    });

    logger.info('Upcoming activities data retrieved', { 
      count: upcomingActivities.length
    });

    res.json({
      success: true,
      data: upcomingActivities
    });
  } catch (error) {
    logger.error('Error fetching upcoming activities:', error);
    throw new AppError('Failed to fetch upcoming activities', 500, 'UPCOMING_ACTIVITIES_ERROR');
  }
}));

export default router;