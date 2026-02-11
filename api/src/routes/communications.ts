import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';

const router = Router();

// Email Templates Management
router.get('/templates', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', trigger, active } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (trigger) where.trigger = trigger;
    if (active !== undefined) where.active = active === 'true';

    const [templates, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.emailTemplate.findMany({
          where,
          include: {
            creator: {
              select: { firstName: true, lastName: true, email: true }
            },
            _count: {
              select: { emails: true }
            }
          },
          orderBy: { updatedAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.emailTemplate.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: templates,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching email templates:', error);
    throw new AppError('Failed to fetch email templates', 500, 'TEMPLATES_FETCH_ERROR');
  }
}));

router.post('/templates', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      name,
      trigger,
      subjectTemplate,
      bodyHtmlTemplate,
      bodyTextTemplate,
      brandOverrides,
      placeholders
    } = req.body;

    const template = await safePrismaQuery(async (client) => {
      return await client.emailTemplate.create({
        data: {
          name,
          trigger,
          subjectTemplate,
          bodyHtmlTemplate,
          bodyTextTemplate,
          brandOverrides: brandOverrides || {},
          placeholders: placeholders || [],
          createdBy: req.user!.id
        },
        include: {
          creator: {
            select: { firstName: true, lastName: true, email: true }
          }
        }
      });
    });

    logger.info('Email template created', {
      templateId: template.id,
      name: template.name,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Email template created successfully',
      data: template
    });
  } catch (error) {
    logger.error('Error creating email template:', error);
    throw new AppError('Failed to create email template', 500, 'TEMPLATE_CREATE_ERROR');
  }
}));

router.put('/templates/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      trigger,
      subjectTemplate,
      bodyHtmlTemplate,
      bodyTextTemplate,
      brandOverrides,
      placeholders,
      active
    } = req.body;

    const template = await safePrismaQuery(async (client) => {
      return await client.emailTemplate.update({
        where: { id },
        data: {
          name,
          trigger,
          subjectTemplate,
          bodyHtmlTemplate,
          bodyTextTemplate,
          brandOverrides: brandOverrides || {},
          placeholders: placeholders || [],
          active: active !== undefined ? active : true
        },
        include: {
          creator: {
            select: { firstName: true, lastName: true, email: true }
          }
        }
      });
    });

    logger.info('Email template updated', {
      templateId: template.id,
      name: template.name,
      updatedBy: req.user!.id
    });

    res.json({
      success: true,
      message: 'Email template updated successfully',
      data: template
    });
  } catch (error) {
    logger.error('Error updating email template:', error);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      throw new AppError('Email template not found', 404, 'TEMPLATE_NOT_FOUND');
    }
    throw new AppError('Failed to update email template', 500, 'TEMPLATE_UPDATE_ERROR');
  }
}));

router.delete('/templates/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await safePrismaQuery(async (client) => {
      return await client.emailTemplate.delete({
        where: { id }
      });
    });

    logger.info('Email template deleted', {
      templateId: id,
      deletedBy: req.user!.id
    });

    res.json({
      success: true,
      message: 'Email template deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting email template:', error);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      throw new AppError('Email template not found', 404, 'TEMPLATE_NOT_FOUND');
    }
    throw new AppError('Failed to delete email template', 500, 'TEMPLATE_DELETE_ERROR');
  }
}));

// Broadcasts Management
router.get('/broadcasts', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', status, channel } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (status) where.status = status;
    if (channel) where.channels = { has: channel };

    const [broadcasts, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.broadcast.findMany({
          where,
          include: {
            creator: {
              select: { firstName: true, lastName: true, email: true }
            },
            _count: {
              select: { emails: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.broadcast.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: broadcasts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching broadcasts:', error);
    throw new AppError('Failed to fetch broadcasts', 500, 'BROADCASTS_FETCH_ERROR');
  }
}));

router.post('/broadcasts', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      title,
      subject,
      bodyHtml,
      bodyText,
      audienceQuery,
      channels,
      scheduledFor
    } = req.body;

    const broadcast = await safePrismaQuery(async (client) => {
      return await client.broadcast.create({
        data: {
          title,
          subject,
          bodyHtml,
          bodyText,
          audienceQuery: audienceQuery || { type: 'all' },
          channels: channels || ['email'],
          scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
          createdBy: req.user!.id
        },
        include: {
          creator: {
            select: { firstName: true, lastName: true, email: true }
          }
        }
      });
    });

    logger.info('Broadcast created', {
      broadcastId: broadcast.id,
      title: broadcast.title,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Broadcast created successfully',
      data: broadcast
    });
  } catch (error) {
    logger.error('Error creating broadcast:', error);
    throw new AppError('Failed to create broadcast', 500, 'BROADCAST_CREATE_ERROR');
  }
}));

// Email Log
router.get('/emails', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '50',
      search,
      messageType,
      status,
      dateFrom,
      dateTo,
      parentId
    } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    
    if (search) {
      where.OR = [
        { toEmail: { contains: search as string, mode: 'insensitive' } },
        { toName: { contains: search as string, mode: 'insensitive' } },
        { subject: { contains: search as string, mode: 'insensitive' } }
      ];
    }
    
    if (messageType) where.messageType = messageType;
    if (status) where.lastStatus = status;
    if (parentId) where.parentId = parentId;
    
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) where.createdAt.lte = new Date(dateTo as string);
    }

    const [emails, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.email.findMany({
          where,
          include: {
            parent: {
              select: { firstName: true, lastName: true, email: true }
            },
            booking: {
              select: { id: true, activity: { select: { title: true } } }
            },
            broadcast: {
              select: { title: true }
            },
            template: {
              select: { name: true }
            },
            events: {
              orderBy: { occurredAt: 'desc' },
              take: 1
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.email.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: emails,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching email log:', error);
    throw new AppError('Failed to fetch email log', 500, 'EMAIL_LOG_FETCH_ERROR');
  }
}));

// Get email details with events timeline
router.get('/emails/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const email = await safePrismaQuery(async (client) => {
      return await client.email.findUnique({
        where: { id },
        include: {
          parent: {
            select: { firstName: true, lastName: true, email: true }
          },
          booking: {
            select: { 
              id: true, 
              activity: { select: { title: true } },
              child: { select: { firstName: true, lastName: true } }
            }
          },
          broadcast: {
            select: { title: true }
          },
          template: {
            select: { name: true }
          },
          events: {
            orderBy: { occurredAt: 'asc' }
          }
        }
      });
    });

    if (!email) {
      throw new AppError('Email not found', 404, 'EMAIL_NOT_FOUND');
    }

    res.json({
      success: true,
      data: email
    });
  } catch (error) {
    logger.error('Error fetching email details:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch email details', 500, 'EMAIL_DETAILS_FETCH_ERROR');
  }
}));

// Mark email as read (for notifications)
router.post('/emails/:id/mark-read', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await safePrismaQuery(async (client) => {
      return await client.email.update({
        where: { id },
        data: {
          lastStatus: 'opened',
          lastStatusAt: new Date()
        }
      });
    });

    res.json({
      success: true,
      message: 'Email marked as read'
    });
  } catch (error) {
    logger.error('Error marking email as read:', error);
    throw new AppError('Failed to mark email as read', 500, 'EMAIL_MARK_READ_ERROR');
  }
}));

// Get communication statistics
router.get('/stats', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { period = '30d' } = req.query;
    
    let dateFilter: any = {};
    const now = new Date();
    
    switch (period) {
      case '7d':
        dateFilter.gte = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        dateFilter.gte = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        dateFilter.gte = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
    }

    const [emailStats, broadcastStats] = await Promise.all([
      safePrismaQuery(async (client) => {
        const emails = await client.email.findMany({
          where: { createdAt: dateFilter },
          select: { lastStatus: true }
        });

        const total = emails.length;
        const delivered = emails.filter(e => ['delivered', 'opened', 'clicked'].includes(e.lastStatus)).length;
        const opened = emails.filter(e => ['opened', 'clicked'].includes(e.lastStatus)).length;
        const clicked = emails.filter(e => e.lastStatus === 'clicked').length;
        const bounced = emails.filter(e => e.lastStatus === 'bounced').length;

        return {
          total,
          delivered,
          opened,
          clicked,
          bounced,
          deliveryRate: total > 0 ? (delivered / total) * 100 : 0,
          openRate: delivered > 0 ? (opened / delivered) * 100 : 0,
          clickRate: opened > 0 ? (clicked / opened) * 100 : 0
        };
      }),
      safePrismaQuery(async (client) => {
        return await client.broadcast.count({
          where: { createdAt: dateFilter }
        });
      })
    ]);

    res.json({
      success: true,
      data: {
        emails: emailStats,
        broadcasts: broadcastStats,
        period
      }
    });
  } catch (error) {
    logger.error('Error fetching communication stats:', error);
    throw new AppError('Failed to fetch communication stats', 500, 'COMM_STATS_FETCH_ERROR');
  }
}));

export default router;
