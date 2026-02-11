import { Router, Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { walletService } from '../services/walletService';
import { logger } from '../utils/logger';
import { validationResult } from 'express-validator';

const router = Router();

// Validation middleware
const validateCreditUsage = [
  body('amount').isDecimal().withMessage('Valid amount is required'),
  body('bookingId').isUUID().withMessage('Valid booking ID is required'),
  body('transactionId').isString().withMessage('Transaction ID is required')
];

const validateCreditTransfer = [
  body('fromProviderId').isString().withMessage('From provider ID is required'),
  body('toProviderId').isString().withMessage('To provider ID is required'),
  body('amount').isDecimal().withMessage('Valid amount is required')
];

// Get wallet balance
router.get('/balance', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { providerId } = req.query;

    const balance = await walletService.getWalletBalance(userId, providerId as string);

    res.json({
      success: true,
      data: balance
    });
  } catch (error) {
    logger.error('Error getting wallet balance:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get wallet balance', 500, 'WALLET_BALANCE_ERROR');
  }
}));

// Use credits for booking
router.post('/use', authenticateToken, validateCreditUsage, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const userId = req.user!.id;
    const { amount, bookingId, transactionId } = req.body;

    const usage = await walletService.useCredits(userId, amount, bookingId, transactionId);

    logger.info('Credits used via API', {
      userId,
      amount,
      bookingId,
      transactionId,
      creditsUsed: usage.length
    });

    res.status(201).json({
      success: true,
      message: 'Credits used successfully',
      data: usage
    });
  } catch (error) {
    logger.error('Error using credits:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to use credits', 500, 'CREDIT_USAGE_ERROR');
  }
}));

// Issue credit (admin only)
router.post('/issue', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { 
      parentId, 
      amount, 
      source, 
      providerId, 
      bookingId, 
      description, 
      expiryMonths = 12 
    } = req.body;

    const credit = await walletService.issueCredit(
      parentId,
      amount,
      source,
      providerId,
      bookingId,
      description,
      expiryMonths
    );

    logger.info('Credit issued via API', {
      adminId: user.id,
      parentId,
      amount,
      source,
      providerId,
      creditId: credit.id
    });

    res.status(201).json({
      success: true,
      message: 'Credit issued successfully',
      data: credit
    });
  } catch (error) {
    logger.error('Error issuing credit:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to issue credit', 500, 'CREDIT_ISSUE_ERROR');
  }
}));

// Transfer credits between providers
router.post('/transfer', authenticateToken, validateCreditTransfer, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const userId = req.user!.id;
    const { fromProviderId, toProviderId, amount } = req.body;

    const result = await walletService.transferCredits(userId, fromProviderId, toProviderId, amount);

    logger.info('Credits transferred via API', {
      userId,
      fromProviderId,
      toProviderId,
      amount,
      fromCreditId: result.fromCredit?.id,
      toCreditId: result.toCredit.id
    });

    res.status(201).json({
      success: true,
      message: 'Credits transferred successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error transferring credits:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to transfer credits', 500, 'CREDIT_TRANSFER_ERROR');
  }
}));

// Get credit history
router.get('/history', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { limit = 50 } = req.query;

    const history = await walletService.getCreditHistory(userId, Number(limit));

    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    logger.error('Error getting credit history:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get credit history', 500, 'CREDIT_HISTORY_ERROR');
  }
}));

// Get expiring credits (admin only)
router.get('/expiring', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { daysAhead = 30 } = req.query;
    const expiringCredits = await walletService.getExpiringCredits(Number(daysAhead));

    res.json({
      success: true,
      data: expiringCredits
    });
  } catch (error) {
    logger.error('Error getting expiring credits:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get expiring credits', 500, 'EXPIRING_CREDITS_ERROR');
  }
}));

// Process expired credits (admin only)
router.post('/process-expired', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const expiredCount = await walletService.processExpiredCredits();

    logger.info('Expired credits processed via API', {
      adminId: user.id,
      expiredCount
    });

    res.json({
      success: true,
      message: `Processed ${expiredCount} expired credits`,
      data: { expiredCount }
    });
  } catch (error) {
    logger.error('Error processing expired credits:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to process expired credits', 500, 'PROCESS_EXPIRED_ERROR');
  }
}));

// Get wallet statistics (admin only)
router.get('/stats', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (!['admin', 'staff'].includes(user.role)) {
      throw new AppError('Admin or staff access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const { providerId } = req.query;
    const stats = await walletService.getWalletStats(providerId as string);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error getting wallet stats:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get wallet stats', 500, 'WALLET_STATS_ERROR');
  }
}));

export default router;
