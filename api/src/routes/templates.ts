import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';

// Role-based permission middleware
const requireRole = (roles: string[]) => {
  return (req: Request, res: Response, next: Function) => {
    const userRole = req.user?.role;
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        error: 'FORBIDDEN'
      });
    }
    next();
  };
};

const router = Router();

// Get all templates
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { search, type, years, status = 'active', page = '1', limit = '20' } = req.query;
    const userId = req.user!.id;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;
    
    logger.info('Templates requested', { 
      user: req.user?.email,
      search,
      type,
      years,
      status,
      page: pageNum,
      limit: limitNum,
      userId 
    });

    const startTime = performance.now();

    const result = await safePrismaQuery(async (client) => {
      const where: any = {
        createdBy: userId,
        ...(status === 'active' ? { status: 'active' } : 
            status === 'archived' ? { status: 'archived' } : 
            status === 'all' ? {} : { status: 'active' })
      };

      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { description: { contains: search as string, mode: 'insensitive' } }
        ];
      }

      if (type) {
        where.type = type;
      }

      if (years) {
        where.years = years;
      }

      // Get total count for pagination
      const totalCount = await client.template.count({ where });

      // Get paginated templates
      const templates = await client.template.findMany({
        where,
        include: {
          creator: {
            select: {
              firstName: true,
              lastName: true
            }
          },
          _count: {
            select: {
              courses: true
            }
          }
        },
        orderBy: {
          updatedAt: 'desc'
        },
        skip,
        take: limitNum
      });

      return {
        templates,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
          hasNext: pageNum < Math.ceil(totalCount / limitNum),
          hasPrev: pageNum > 1
        }
      };
    });

    const endTime = performance.now();
    const loadTime = endTime - startTime;

    logger.info('Templates retrieved', { 
      count: result.templates.length,
      total: result.pagination.total,
      loadTime: `${loadTime.toFixed(2)}ms`
    });

    // Set cache headers for performance
    res.set({
      'Cache-Control': 'private, max-age=60', // Cache for 1 minute
      'X-Load-Time': `${loadTime.toFixed(2)}ms`
    });

    res.json({
      success: true,
      data: result.templates,
      pagination: result.pagination
    });
  } catch (error) {
    logger.error('Error fetching templates:', error);
    throw new AppError('Failed to fetch templates', 500, 'TEMPLATES_FETCH_ERROR');
  }
}));

// Get single template
router.get('/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    
    logger.info('Template requested', { 
      user: req.user?.email,
      templateId: id,
      userId 
    });

    const template = await safePrismaQuery(async (client) => {
      return await client.template.findFirst({
        where: {
          id: id,
          createdBy: userId
        },
        include: {
          creator: {
            select: {
              firstName: true,
              lastName: true
            }
          },
          courses: {
            select: {
              id: true,
              name: true,
              startDate: true,
              endDate: true,
              status: true
            },
            orderBy: {
              createdAt: 'desc'
            },
            take: 5
          }
        }
      });
    });

    if (!template) {
      throw new AppError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
    }

    logger.info('Template retrieved', { 
      templateId: id 
    });

    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    logger.error('Error fetching template:', error);
    throw error;
  }
}));

// Create new template
router.post('/', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      name,
      type,
      years,
      description,
      defaultPrice,
      defaultCapacity,
      requiresPhotoConsent = false,
      requiresMedicalReminder = false,
      tags = [],
      image
    } = req.body;
    
    logger.info('Creating template', { 
      user: req.user?.email,
      name,
      type,
      userId 
    });

    const template = await safePrismaQuery(async (client) => {
      return await client.template.create({
        data: {
          name,
          type,
          years,
          description,
          defaultPrice: parseFloat(defaultPrice),
          defaultCapacity: parseInt(defaultCapacity),
          flags: {
            photo_consent_required: requiresPhotoConsent || false,
            medical_reminder: requiresMedicalReminder || false
          },
          tags,
          imageUrl: image,
          createdBy: userId
        },
        include: {
          creator: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      });
    });

    logger.info('Template created', { 
      templateId: template.id 
    });

    res.status(201).json({
      success: true,
      data: template
    });
  } catch (error) {
    logger.error('Error creating template:', error);
    throw error;
  }
}));

// Update template (Admin only)
router.put('/:id', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const updateData = req.body;
    
    logger.info('Updating template', { 
      user: req.user?.email,
      templateId: id,
      userId 
    });

    const template = await safePrismaQuery(async (client) => {
      // Check if template exists and belongs to user
      const existingTemplate = await client.template.findFirst({
        where: {
          id: id,
          createdBy: userId
        }
      });

      if (!existingTemplate) {
        throw new AppError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
      }

      return await client.template.update({
        where: { id: id },
        data: {
          ...updateData,
          updatedAt: new Date()
        },
        include: {
          creator: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      });
    });

    logger.info('Template updated', { 
      templateId: id 
    });

    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    logger.error('Error updating template:', error);
    throw error;
  }
}));

// Archive template (Admin only)
router.patch('/:id/archive', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    
    logger.info('Archiving template', { 
      user: req.user?.email,
      templateId: id,
      userId 
    });

    const template = await safePrismaQuery(async (client) => {
      return await client.template.update({
        where: {
          id: id,
          createdBy: userId
        },
        data: {
          status: 'archived',
          updatedAt: new Date()
        }
      });
    });

    logger.info('Template archived', { 
      templateId: id 
    });

    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    logger.error('Error archiving template:', error);
    throw error;
  }
}));

// Unarchive template
router.patch('/:id/unarchive', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    
    logger.info('Unarchiving template', { 
      user: req.user?.email,
      templateId: id,
      userId 
    });

    const template = await safePrismaQuery(async (client) => {
      return await client.template.update({
        where: {
          id: id,
          createdBy: userId
        },
        data: {
          status: 'active',
          updatedAt: new Date()
        }
      });
    });

    logger.info('Template unarchived', { 
      templateId: id 
    });

    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    logger.error('Error unarchiving template:', error);
    throw error;
  }
}));

// Delete template (Admin only)
router.delete('/:id', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    
    logger.info('Deleting template', { 
      user: req.user?.email,
      templateId: id,
      userId 
    });

    await safePrismaQuery(async (client) => {
      // Check if template exists and belongs to user
      const existingTemplate = await client.template.findFirst({
        where: {
          id: id,
          createdBy: userId
        }
      });

      if (!existingTemplate) {
        throw new AppError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
      }

      // Check if template has any activities
      // Note: Activity model doesn't have templateId field, so we can't check this
      // For now, we'll allow deletion (you may want to add templateId to Activity model if needed)
      const activityCount = 0;

      if (activityCount > 0) {
        throw new AppError('Cannot delete template with existing activities', 400, 'TEMPLATE_HAS_ACTIVITIES');
      }

      return await client.template.delete({
        where: { id: id }
      });
    });

    logger.info('Template deleted', { 
      templateId: id 
    });

    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting template:', error);
    throw error;
  }
}));

// Create activity from template
router.post('/:id/create-activity', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const {
      name,
      venueIds,
      startDate,
      endDate,
      startTime,
      endTime,
      price,
      capacity,
      description
    } = req.body;
    
    logger.info('Creating activity from template', { 
      user: req.user?.email,
      templateId: id,
      userId 
    });

    const template = await safePrismaQuery(async (client) => {
      // Get template
      const templateData = await client.template.findFirst({
        where: {
          id: id,
          createdBy: userId,
          status: 'active'
        }
      });

      if (!templateData) {
        throw new AppError('Template not found or inactive', 404, 'TEMPLATE_NOT_FOUND');
      }

      // Create activity for each venue
      const activities = [];
      for (const venueId of venueIds) {
        const activity = await client.activity.create({
          data: {
            title: name || templateData.name,
            description: description || templateData.description,
            venueId: venueId,
            ownerId: userId,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            startTime: startTime,
            endTime: endTime,
            price: parseFloat(price || templateData.defaultPrice || 0),
            capacity: parseInt(capacity || templateData.defaultCapacity?.toString() || '0'),
            isActive: true
          },
          include: {
            venue: {
              select: {
                name: true
              }
            }
          }
        });
        activities.push(activity);
      }

      return activities;
    });

    logger.info('Activities created from template', { 
      templateId: id,
      activityCount: template.length 
    });

    res.status(201).json({
      success: true,
      data: template
    });
  } catch (error) {
    logger.error('Error creating activity from template:', error);
    throw error;
  }
}));

export default router;
