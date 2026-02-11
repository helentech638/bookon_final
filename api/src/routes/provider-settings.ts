import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { logger } from '../utils/logger';
import { validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';

const router = Router();

// Validation middleware
const validateProviderSettings = [
  body('tfcEnabled').isBoolean().withMessage('TFC enabled must be a boolean'),
  body('tfcHoldPeriod').isInt({ min: 1, max: 30 }).withMessage('TFC hold period must be between 1 and 30 days'),
  body('tfcInstructions').optional().isString().isLength({ max: 1000 }).withMessage('TFC instructions must be less than 1000 characters'),
  body('tfcPayeeName').optional().isString().isLength({ max: 100 }).withMessage('TFC payee name must be less than 100 characters'),
  body('tfcPayeeReference').optional().isString().isLength({ max: 50 }).withMessage('TFC payee reference must be less than 50 characters'),
  body('tfcSortCode').optional().matches(/^\d{2}-\d{2}-\d{2}$/).withMessage('Sort code must be in format XX-XX-XX'),
  body('tfcAccountNumber').optional().matches(/^\d{8}$/).withMessage('Account number must be 8 digits'),
  body('defaultRefundMethod').isIn(['credit', 'cash', 'parent_choice']).withMessage('Invalid refund method'),
  body('adminFeeAmount').isDecimal().withMessage('Admin fee must be a valid decimal'),
  body('creditExpiryMonths').isInt({ min: 1, max: 24 }).withMessage('Credit expiry must be between 1 and 24 months'),
  body('cancellationPolicy').optional().isObject().withMessage('Cancellation policy must be an object')
];

const validateProviderId = [
  param('providerId').isUUID().withMessage('Valid provider ID is required')
];

// Get provider settings
router.get('/:providerId', authenticateToken, validateProviderId, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const user = req.user!;
    const { providerId } = req.params;

    // Check if user has access to this provider
    if (user.role !== 'admin' && user.id !== providerId) {
      throw new AppError('Access denied', 403, 'ACCESS_DENIED');
    }

    let settings = await prisma.providerSettings.findUnique({
      where: { providerId }
    });

    // Create default settings if none exist
    if (!settings) {
      settings = await prisma.providerSettings.create({
        data: {
          providerId,
          tfcEnabled: false,
          tfcHoldPeriod: 5,
          tfcInstructions: null,
          defaultRefundMethod: 'credit',
          adminFeeAmount: 2.00,
          creditExpiryMonths: 12,
          cancellationPolicy: {
            parentCancellation: {
              before24Hours: {
                refundMethod: 'parent_choice',
                adminFee: 2.00,
                description: 'Parent can choose cash refund or credit (minus admin fee)'
              },
              within24Hours: {
                refundMethod: 'credit',
                adminFee: 2.00,
                description: 'Credit only (minus admin fee)'
              }
            },
            providerCancellation: {
              refundMethod: 'parent_choice',
              adminFee: 0.00,
              description: 'Full refund or credit (no admin fee)'
            },
            noShow: {
              refundMethod: 'none',
              adminFee: 0.00,
              description: 'No refund for no-shows'
            }
          }
        }
      });
    }

    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    logger.error('Error getting provider settings:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get provider settings', 500, 'PROVIDER_SETTINGS_ERROR');
  }
}));

// Update provider settings
router.put('/:providerId', authenticateToken, validateProviderId, validateProviderSettings, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const user = req.user!;
    const { providerId } = req.params;
    const {
      tfcEnabled,
      tfcHoldPeriod,
      tfcInstructions,
      tfcPayeeName,
      tfcPayeeReference,
      tfcSortCode,
      tfcAccountNumber,
      defaultRefundMethod,
      adminFeeAmount,
      creditExpiryMonths,
      cancellationPolicy
    } = req.body;

    // Check if user has access to this provider
    if (user.role !== 'admin' && user.id !== providerId) {
      throw new AppError('Access denied', 403, 'ACCESS_DENIED');
    }

    const settings = await prisma.providerSettings.upsert({
      where: { providerId },
      update: {
        tfcEnabled,
        tfcHoldPeriod,
        tfcInstructions,
        tfcPayeeName,
        tfcPayeeReference,
        tfcSortCode,
        tfcAccountNumber,
        defaultRefundMethod,
        adminFeeAmount,
        creditExpiryMonths,
        cancellationPolicy,
        updatedAt: new Date()
      },
      create: {
        providerId,
        tfcEnabled,
        tfcHoldPeriod,
        tfcInstructions,
        tfcPayeeName,
        tfcPayeeReference,
        tfcSortCode,
        tfcAccountNumber,
        defaultRefundMethod,
        adminFeeAmount,
        creditExpiryMonths,
        cancellationPolicy
      }
    });

    logger.info('Provider settings updated', {
      adminId: user.id,
      providerId,
      tfcEnabled,
      tfcHoldPeriod,
      adminFeeAmount
    });

    res.json({
      success: true,
      message: 'Provider settings updated successfully',
      data: settings
    });
  } catch (error) {
    logger.error('Error updating provider settings:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to update provider settings', 500, 'PROVIDER_SETTINGS_UPDATE_ERROR');
  }
}));

// Get all provider settings (admin only)
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const settings = await prisma.providerSettings.findMany({
      orderBy: { updatedAt: 'desc' }
    });

    // Enrich with venue information
    const enrichedSettings = await Promise.all(
      settings.map(async (setting) => {
        const venue = await prisma.venue.findUnique({
          where: { id: setting.providerId },
          select: {
            name: true,
            email: true,
            phone: true,
            city: true
          }
        });

        return {
          ...setting,
          venue: venue || null
        };
      })
    );

    res.json({
      success: true,
      data: enrichedSettings
    });
  } catch (error) {
    logger.error('Error getting all provider settings:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get provider settings', 500, 'PROVIDER_SETTINGS_LIST_ERROR');
  }
}));

// Reset provider settings to defaults
router.post('/:providerId/reset', authenticateToken, validateProviderId, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const user = req.user!;
    const { providerId } = req.params;

    // Check if user has access to this provider
    if (user.role !== 'admin' && user.id !== providerId) {
      throw new AppError('Access denied', 403, 'ACCESS_DENIED');
    }

    const defaultSettings = {
      tfcEnabled: false,
      tfcHoldPeriod: 5,
      tfcInstructions: null,
      defaultRefundMethod: 'credit' as const,
      adminFeeAmount: 2.00,
      creditExpiryMonths: 12,
      cancellationPolicy: {
        parentCancellation: {
          before24Hours: {
            refundMethod: 'parent_choice',
            adminFee: 2.00,
            description: 'Parent can choose cash refund or credit (minus admin fee)'
          },
          within24Hours: {
            refundMethod: 'credit',
            adminFee: 2.00,
            description: 'Credit only (minus admin fee)'
          }
        },
        providerCancellation: {
          refundMethod: 'parent_choice',
          adminFee: 0.00,
          description: 'Full refund or credit (no admin fee)'
        },
        noShow: {
          refundMethod: 'none',
          adminFee: 0.00,
          description: 'No refund for no-shows'
        }
      }
    };

    const settings = await prisma.providerSettings.upsert({
      where: { providerId },
      update: {
        ...defaultSettings,
        updatedAt: new Date()
      },
      create: {
        providerId,
        ...defaultSettings
      }
    });

    logger.info('Provider settings reset to defaults', {
      adminId: user.id,
      providerId
    });

    res.json({
      success: true,
      message: 'Provider settings reset to defaults',
      data: settings
    });
  } catch (error) {
    logger.error('Error resetting provider settings:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to reset provider settings', 500, 'PROVIDER_SETTINGS_RESET_ERROR');
  }
}));

// Get provider settings summary (admin dashboard)
router.get('/admin/summary', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    if (user.role !== 'admin') {
      throw new AppError('Admin access required', 403, 'ADMIN_ACCESS_REQUIRED');
    }

    const stats = await prisma.providerSettings.groupBy({
      by: ['tfcEnabled'],
      _count: {
        providerId: true
      }
    });

    const totalProviders = await prisma.providerSettings.count();
    const tfcEnabledCount = stats.find(s => s.tfcEnabled)?._count.providerId || 0;
    const tfcDisabledCount = totalProviders - tfcEnabledCount;

    const averageSettings = await prisma.providerSettings.aggregate({
      _avg: {
        tfcHoldPeriod: true,
        adminFeeAmount: true,
        creditExpiryMonths: true
      }
    });

    res.json({
      success: true,
      data: {
        totalProviders,
        tfcEnabled: tfcEnabledCount,
        tfcDisabled: tfcDisabledCount,
        averageSettings: {
          tfcHoldPeriod: averageSettings._avg.tfcHoldPeriod || 5,
          adminFeeAmount: averageSettings._avg.adminFeeAmount || 2.00,
          creditExpiryMonths: averageSettings._avg.creditExpiryMonths || 12
        }
      }
    });
  } catch (error) {
    logger.error('Error getting provider settings summary:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to get provider settings summary', 500, 'PROVIDER_SETTINGS_SUMMARY_ERROR');
  }
}));

export default router;
