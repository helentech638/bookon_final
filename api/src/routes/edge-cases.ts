import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { edgeCaseService } from '../services/edgeCaseService';
import { logger } from '../utils/logger';
import { validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';

const router = Router();

// Validation middleware
const validateTransferRequest = [
  body('fromBookingId').isUUID().withMessage('Valid booking ID is required'),
  body('toActivityId').isUUID().withMessage('Valid activity ID is required'),
  body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Valid reason is required'),
  body('transferDate').optional().isISO8601().withMessage('Valid transfer date is required')
];

const validateChargebackData = [
  body('bookingId').isUUID().withMessage('Valid booking ID is required'),
  body('chargebackId').isString().withMessage('Chargeback ID is required'),
  body('amount').isDecimal().withMessage('Valid amount is required'),
  body('reason').isString().withMessage('Reason is required'),
  body('status').isIn(['pending', 'won', 'lost']).withMessage('Valid status is required'),
  body('receivedAt').isISO8601().withMessage('Valid received date is required'),
  body('evidenceDueDate').optional().isISO8601().withMessage('Valid evidence due date is required')
];

const validatePartialRefund = [
  body('bookingId').isUUID().withMessage('Valid booking ID is required'),
  body('refundAmount').isDecimal().withMessage('Valid refund amount is required'),
  body('refundMethod').isIn(['card', 'credit', 'mixed']).withMessage('Valid refund method is required'),
  body('reason').isString().withMessage('Reason is required')
];

// Process booking transfer
router.post('/transfer', authenticateToken, validateTransferRequest, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const user = req.user!;
    const { fromBookingId, toActivityId, reason, transferDate } = req.body;
    const parentId = user.id;
    const adminId = user.role === 'admin' ? user.id : undefined;

    const result = await edgeCaseService.processBookingTransfer({
      fromBookingId,
      toActivityId,
      parentId,
      reason,
      transferDate: transferDate ? new Date(transferDate) : undefined
    }, adminId);

    logger.info('Booking transfer processed via API', {
      userId: user.id,
      userRole: user.role,
      fromBookingId,
      toActivityId,
      result
    });

    res.status(201).json({
      success: true,
      message: 'Booking transfer processed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error processing booking transfer:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process booking transfer', 500, 'TRANSFER_ERROR');
  }
}));

// Process chargeback (admin only)
router.post('/chargeback', authenticateToken, validateChargebackData, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { bookingId, chargebackId, amount, reason, status, receivedAt, evidenceDueDate } = req.body;
    const adminId = user.id;

    await edgeCaseService.processChargeback({
      bookingId,
      chargebackId,
      amount,
      reason,
      status,
      receivedAt: new Date(receivedAt),
      evidenceDueDate: evidenceDueDate ? new Date(evidenceDueDate) : undefined
    }, adminId);

    logger.info('Chargeback processed via API', {
      adminId,
      bookingId,
      chargebackId,
      amount,
      reason,
      status
    });

    res.status(201).json({
      success: true,
      message: 'Chargeback processed successfully'
    });
  } catch (error) {
    logger.error('Error processing chargeback:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process chargeback', 500, 'CHARGEBACK_ERROR');
  }
}));

// Resolve chargeback (admin only)
router.post('/chargeback/:chargebackId/resolve', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { chargebackId } = req.params;
    const { resolution, notes } = req.body;
    const adminId = user.id;

    if (!['won', 'lost'].includes(resolution)) {
      throw new AppError('Invalid resolution. Must be "won" or "lost"', 400, 'INVALID_RESOLUTION');
    }

    await edgeCaseService.resolveChargeback(chargebackId, resolution, adminId, notes);

    logger.info('Chargeback resolved via API', {
      adminId,
      chargebackId,
      resolution,
      notes
    });

    res.json({
      success: true,
      message: 'Chargeback resolved successfully'
    });
  } catch (error) {
    logger.error('Error resolving chargeback:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to resolve chargeback', 500, 'CHARGEBACK_RESOLUTION_ERROR');
  }
}));

// Process partial refund (admin only)
router.post('/partial-refund', authenticateToken, validatePartialRefund, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { bookingId, refundAmount, refundMethod, reason } = req.body;
    const adminId = user.id;

    const result = await edgeCaseService.processPartialRefund(
      bookingId,
      refundAmount,
      refundMethod,
      adminId,
      reason
    );

    logger.info('Partial refund processed via API', {
      adminId,
      bookingId,
      refundAmount,
      refundMethod,
      reason,
      result
    });

    res.status(201).json({
      success: true,
      message: 'Partial refund processed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error processing partial refund:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process partial refund', 500, 'PARTIAL_REFUND_ERROR');
  }
}));

// Process bulk operations (admin only)
router.post('/bulk-operation', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { operationName, operations } = req.body;
    const adminId = user.id;

    if (!operationName || !Array.isArray(operations)) {
      throw new AppError('Operation name and operations array are required', 400, 'INVALID_BULK_OPERATION');
    }

    // Convert operation strings to functions (this is a simplified example)
    const operationFunctions = operations.map((op: any) => {
      return async () => {
        // In a real implementation, you'd parse the operation and execute it
        // For now, we'll just return the operation data
        return op;
      };
    });

    const result = await edgeCaseService.processBulkOperation(
      operationFunctions,
      operationName,
      adminId
    );

    logger.info('Bulk operation processed via API', {
      adminId,
      operationName,
      totalOperations: operations.length,
      result
    });

    res.status(201).json({
      success: true,
      message: 'Bulk operation processed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error processing bulk operation:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process bulk operation', 500, 'BULK_OPERATION_ERROR');
  }
}));

// System recovery (admin only)
router.post('/system-recovery', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { errorType, affectedEntities } = req.body;
    const adminId = user.id;

    if (!errorType || !Array.isArray(affectedEntities)) {
      throw new AppError('Error type and affected entities array are required', 400, 'INVALID_RECOVERY_REQUEST');
    }

    await edgeCaseService.recoverFromSystemError(errorType, affectedEntities, adminId);

    logger.info('System recovery processed via API', {
      adminId,
      errorType,
      affectedEntities: affectedEntities.length
    });

    res.status(201).json({
      success: true,
      message: 'System recovery completed successfully'
    });
  } catch (error) {
    logger.error('Error processing system recovery:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process system recovery', 500, 'SYSTEM_RECOVERY_ERROR');
  }
}));

// Get chargeback list (admin only)
router.get('/chargebacks', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { status, limit = 50 } = req.query;

    const whereClause: any = {};
    if (status) {
      whereClause.status = status;
    }

    const chargebacks = await prisma.chargeback.findMany({
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
      orderBy: { receivedAt: 'desc' },
      take: Number(limit)
    });

    const formattedChargebacks = chargebacks.map(chargeback => ({
      id: chargeback.id,
      chargebackId: chargeback.chargebackId,
      bookingId: chargeback.bookingId,
      amount: chargeback.amount,
      reason: chargeback.reason,
      status: chargeback.status,
      receivedAt: chargeback.receivedAt,
      evidenceDueDate: chargeback.evidenceDueDate,
      resolvedAt: chargeback.resolvedAt,
      resolvedBy: chargeback.resolvedBy,
      resolutionNotes: chargeback.resolutionNotes,
      child: `${chargeback.booking.child.firstName} ${chargeback.booking.child.lastName}`,
      parent: `${chargeback.booking.parent.firstName} ${chargeback.booking.parent.lastName}`,
      parentEmail: chargeback.booking.parent.email,
      activity: chargeback.booking.activity.title,
      venue: chargeback.booking.activity.venue.name,
      venueId: chargeback.booking.activity.venue.id
    }));

    res.json({
      success: true,
      data: formattedChargebacks
    });
  } catch (error) {
    logger.error('Error getting chargebacks:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get chargebacks', 500, 'CHARGEBACK_LIST_ERROR');
  }
}));

export default router;
