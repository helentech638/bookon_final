import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken, requireRole } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';
import { registerService } from '../services/registerService';

const router = Router();

// Get all registers with filters
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      activityId,
      sessionId,
      dateFrom,
      dateTo,
      page = '1',
      limit = '20'
    } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where: any = {};
    
    if (activityId) where.activityId = activityId as string;
    // Note: Register model doesn't have sessionId field - removed sessionId filter
    
    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.gte = new Date(dateFrom as string);
      if (dateTo) where.date.lte = new Date(dateTo as string);
    }

    const [registers, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.register.findMany({
          where,
          skip,
          take,
          include: {
            activity: {
              select: {
                title: true,
                type: true,
                venue: {
                  select: {
                    name: true,
                    address: true
                  }
                }
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          },
          orderBy: { date: 'desc' }
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.register.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: registers,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string))
      }
    });
  } catch (error) {
    logger.error('Error fetching registers:', error);
    throw new AppError('Failed to fetch registers', 500, 'REGISTERS_FETCH_ERROR');
  }
}));

// Get single register
router.get('/:id', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const register = await registerService.getRegister(id);
    
    if (!register) {
      throw new AppError('Register not found', 404, 'REGISTER_NOT_FOUND');
    }

    res.json({
      success: true,
      data: register
    });
  } catch (error) {
    logger.error('Error fetching register:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch register', 500, 'REGISTER_FETCH_ERROR');
  }
}));

// Create register
router.post('/', authenticateToken, requireRole(['admin', 'coordinator']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { sessionId, capacity, notes } = req.body;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const register = await registerService.createRegister(sessionId, capacity, notes);

    logger.info('Register created', {
      registerId: register.id,
      sessionId,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Register created successfully',
      data: register
    });
  } catch (error) {
    logger.error('Error creating register:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to create register', 500, 'REGISTER_CREATE_ERROR');
  }
}));

// Auto-create registers for activity
router.post('/auto-create', authenticateToken, requireRole(['admin', 'coordinator']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { activityId, startDate, endDate } = req.body;

    if (!activityId) {
      throw new AppError('Activity ID is required', 400, 'MISSING_ACTIVITY_ID');
    }

    const registers = await registerService.autoCreateRegistersForActivity(
      activityId,
      new Date(startDate),
      new Date(endDate)
    );

    logger.info('Registers auto-created', {
      activityId,
      registersCreated: registers.length,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: `${registers.length} registers created successfully`,
      data: registers
    });
  } catch (error) {
    logger.error('Error auto-creating registers:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to create registers', 500, 'REGISTERS_CREATE_ERROR');
  }
}));

// Note: Attendance tracking removed - Register model doesn't support attendance records
// Use bookings to track attendance instead

// Get register stats (using bookings for attendance data)
router.get('/:id/stats', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const register = await registerService.getRegister(id);
    
    if (!register) {
      throw new AppError('Register not found', 404, 'REGISTER_NOT_FOUND');
    }

    // Get bookings for this register's activity and date
    const bookings = await prisma.booking.findMany({
      where: {
        activityId: register.activityId,
        activityDate: register.date,
        status: 'confirmed'
      },
      include: {
        child: {
          select: {
            id: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    const stats = {
      registerId: register.id,
      date: register.date,
      status: register.status,
      totalBookings: bookings.length,
      children: bookings.map(b => ({
        id: b.child.id,
        name: `${b.child.firstName} ${b.child.lastName}`
      }))
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error fetching register stats:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to fetch register stats', 500, 'STATS_FETCH_ERROR');
  }
}));

// Generate attendance report
router.get('/:activityId/report', authenticateToken, requireRole(['admin', 'coordinator']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { activityId } = req.params;
    const { dateFrom, dateTo } = req.query;

    if (!dateFrom || !dateTo) {
      throw new AppError('Date range is required', 400, 'MISSING_DATE_RANGE');
    }

    const report = await registerService.generateAttendanceReport(
      activityId,
      new Date(dateFrom as string),
      new Date(dateTo as string)
    );

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Error generating attendance report:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to generate attendance report', 500, 'REPORT_GENERATE_ERROR');
  }
}));

// Delete register
router.delete('/:id', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    await registerService.deleteRegister(id);

    logger.info('Register deleted', {
      registerId: id,
      deletedBy: req.user!.id
    });

    res.json({
      success: true,
      message: 'Register deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting register:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to delete register', 500, 'REGISTER_DELETE_ERROR');
  }
}));

// Get registers by activity
router.get('/activity/:activityId', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { activityId } = req.params;
    const { dateFrom, dateTo } = req.query;

    const registers = await registerService.getRegistersByActivity(
      activityId,
      dateFrom ? new Date(dateFrom as string) : undefined,
      dateTo ? new Date(dateTo as string) : undefined
    );

    res.json({
      success: true,
      data: registers
    });
  } catch (error) {
    logger.error('Error fetching registers by activity:', error);
    throw new AppError('Failed to fetch registers', 500, 'REGISTERS_FETCH_ERROR');
  }
}));

// Note: Get registers by session removed - Register model doesn't have sessionId
// Use /activity/:activityId or /venue/:venueId endpoints instead

export default router;