import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken, requireRole } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';

const router = Router();

// Transactions Tab
router.get('/transactions', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '50',
      search,
      status,
      paymentMethod,
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
        { parent: { firstName: { contains: search as string, mode: 'insensitive' } } },
        { parent: { lastName: { contains: search as string, mode: 'insensitive' } } },
        { parent: { email: { contains: search as string, mode: 'insensitive' } } },
        { description: { contains: search as string, mode: 'insensitive' } }
      ];
    }
    
    if (status) where.status = status;
    if (paymentMethod) where.paymentMethod = paymentMethod;
    if (parentId) where.parentId = parentId;
    
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) where.createdAt.lte = new Date(dateTo as string);
    }

    const [transactions, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.transaction.findMany({
          where,
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
            refunds: {
              select: { id: true, amount: true, status: true, createdAt: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.transaction.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: transactions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching transactions:', error);
    throw new AppError('Failed to fetch transactions', 500, 'TRANSACTIONS_FETCH_ERROR');
  }
}));

// Discounts Tab
router.get('/discounts', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', active, type } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (active !== undefined) where.active = active === 'true';
    if (type) where.type = type;

    const [discounts, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.discount.findMany({
          where,
          include: {
            creator: {
              select: { firstName: true, lastName: true, email: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.discount.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: discounts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching discounts:', error);
    throw new AppError('Failed to fetch discounts', 500, 'DISCOUNTS_FETCH_ERROR');
  }
}));

router.post('/discounts', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      name,
      code,
      type,
      value,
      minAmount,
      maxUses,
      validFrom,
      validUntil,
      applicableTo,
      venueIds,
      activityIds
    } = req.body;

    const discount = await safePrismaQuery(async (client) => {
      return await client.discount.create({
        data: {
          name,
          code,
          type,
          value,
          minAmount: minAmount ? parseFloat(minAmount) : null,
          maxUses: maxUses ? parseInt(maxUses) : null,
          validFrom: new Date(validFrom),
          validUntil: validUntil ? new Date(validUntil) : null,
          applicableTo: applicableTo || ['all'],
          venueIds: venueIds || [],
          activityIds: activityIds || [],
          createdBy: req.user!.id
        },
        include: {
          creator: {
            select: { firstName: true, lastName: true, email: true }
          }
        }
      });
    });

    logger.info('Discount created', {
      discountId: discount.id,
      code: discount.code,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Discount created successfully',
      data: discount
    });
  } catch (error: any) {
    logger.error('Error creating discount:', error);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new AppError('Discount code already exists', 400, 'DISCOUNT_CODE_EXISTS');
    }
    throw new AppError('Failed to create discount', 500, 'DISCOUNT_CREATE_ERROR');
  }
}));

// Credits Tab
router.get('/credits', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '50', parentId, status, source } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (parentId) where.parentId = parentId;
    if (status) where.status = status;
    if (source) where.source = source;

    const [credits, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.credit.findMany({
          where,
          include: {
            parent: {
              select: { firstName: true, lastName: true, email: true }
            },
            booking: {
              select: { 
                id: true, 
                activity: { select: { title: true } }
              }
            },
            creator: {
              select: { firstName: true, lastName: true, email: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.credit.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: credits,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching credits:', error);
    throw new AppError('Failed to fetch credits', 500, 'CREDITS_FETCH_ERROR');
  }
}));

router.post('/credits', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      parentId,
      amount,
      source,
      description,
      expiresAt,
      bookingId
    } = req.body;

    const credit = await safePrismaQuery(async (client) => {
      return await client.credit.create({
        data: {
          parentId,
          amount: parseFloat(amount),
          source: source || 'manual',
          description,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          bookingId,
          createdBy: req.user!.id
        },
        include: {
          parent: {
            select: { firstName: true, lastName: true, email: true }
          },
          creator: {
            select: { firstName: true, lastName: true, email: true }
          }
        }
      });
    });

    logger.info('Credit issued', {
      creditId: credit.id,
      amount: credit.amount,
      parentId: credit.parentId,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Credit issued successfully',
      data: credit
    });
  } catch (error) {
    logger.error('Error issuing credit:', error);
    throw new AppError('Failed to issue credit', 500, 'CREDIT_ISSUE_ERROR');
  }
}));

// Refunds Tab
router.get('/refunds', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '50',
      search,
      status,
      method,
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
        { parent: { firstName: { contains: search as string, mode: 'insensitive' } } },
        { parent: { lastName: { contains: search as string, mode: 'insensitive' } } },
        { parent: { email: { contains: search as string, mode: 'insensitive' } } },
        { reason: { contains: search as string, mode: 'insensitive' } }
      ];
    }
    
    if (status) where.status = status;
    if (method) where.method = method;
    if (parentId) where.parentId = parentId;
    
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) where.createdAt.lte = new Date(dateTo as string);
    }

    const [refunds, total] = await Promise.all([
      safePrismaQuery(async (client) => {
        return await client.refund.findMany({
          where,
          include: {
            parent: {
              select: { firstName: true, lastName: true, email: true }
            },
            transaction: {
              select: { id: true, amount: true, paymentMethod: true }
            },
            booking: {
              select: { 
                id: true, 
                activity: { select: { title: true } },
                child: { select: { firstName: true, lastName: true } }
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum
        });
      }),
      safePrismaQuery(async (client) => {
        return await client.refund.count({ where });
      })
    ]);

    res.json({
      success: true,
      data: refunds,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error fetching refunds:', error);
    throw new AppError('Failed to fetch refunds', 500, 'REFUNDS_FETCH_ERROR');
  }
}));

router.post('/refunds', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      transactionId,
      parentId,
      amount,
      method,
      reason,
      bookingId
    } = req.body;

    const refund = await safePrismaQuery(async (client) => {
      return await client.refund.create({
        data: {
          transactionId,
          parentId,
          amount: parseFloat(amount),
          method: method || 'original_payment',
          reason,
          bookingId
        },
        include: {
          parent: {
            select: { firstName: true, lastName: true, email: true }
          },
          transaction: {
            select: { id: true, amount: true, paymentMethod: true }
          },
          booking: {
            select: { 
              id: true, 
              activity: { select: { title: true } }
            }
          }
        }
      });
    });

    logger.info('Refund created', {
      refundId: refund.id,
      amount: refund.amount,
      transactionId: refund.transactionId,
      createdBy: req.user!.id
    });

    res.status(201).json({
      success: true,
      message: 'Refund created successfully',
      data: refund
    });
  } catch (error) {
    logger.error('Error creating refund:', error);
    throw new AppError('Failed to create refund', 500, 'REFUND_CREATE_ERROR');
  }
}));

// Finance Reports
router.get('/reports', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { period = '30d', groupBy = 'day' } = req.query;
    
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
      case '1y':
        dateFilter.gte = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
    }

    const [transactionStats, discountStats, creditStats, refundStats] = await Promise.all([
      // Transaction statistics
      safePrismaQuery(async (client) => {
        const transactions = await client.transaction.findMany({
          where: { createdAt: dateFilter },
          select: { amount: true, status: true, paymentMethod: true }
        });

        const total = transactions.reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);
        const paid = transactions.filter(t => t.status === 'paid');
        const paidAmount = paid.reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);
        const failed = transactions.filter(t => t.status === 'failed');
        const pending = transactions.filter(t => t.status === 'pending');

        return {
          total,
          paidAmount,
          paidCount: paid.length,
          failedCount: failed.length,
          pendingCount: pending.length,
          averageTransaction: paid.length > 0 ? paidAmount / paid.length : 0
        };
      }),
      // Discount statistics
      safePrismaQuery(async (client) => {
        const discounts = await client.discount.findMany({
          where: { createdAt: dateFilter },
          select: { value: true, type: true, usedCount: true }
        });

        const totalUsed = discounts.reduce((sum, d) => sum + d.usedCount, 0);
        const totalValue = discounts.reduce((sum, d) => {
          const value = parseFloat(d.value.toString());
          return sum + (d.type === 'percentage' ? value : value * d.usedCount);
        }, 0);

        return {
          totalDiscounts: discounts.length,
          totalUsed,
          totalValue
        };
      }),
      // Credit statistics
      safePrismaQuery(async (client) => {
        const credits = await client.credit.findMany({
          where: { createdAt: dateFilter },
          select: { amount: true, usedAmount: true, status: true }
        });

        const totalIssued = credits.reduce((sum, c) => sum + parseFloat(c.amount.toString()), 0);
        const totalUsed = credits.reduce((sum, c) => sum + parseFloat(c.usedAmount.toString()), 0);
        const active = credits.filter(c => c.status === 'active');

        return {
          totalIssued,
          totalUsed,
          activeCount: active.length,
          unusedAmount: totalIssued - totalUsed
        };
      }),
      // Refund statistics
      safePrismaQuery(async (client) => {
        const refunds = await client.refund.findMany({
          where: { createdAt: dateFilter },
          select: { amount: true, status: true, method: true }
        });

        const total = refunds.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
        const processed = refunds.filter(r => r.status === 'refunded');
        const processing = refunds.filter(r => r.status === 'processing');
        const failed = refunds.filter(r => r.status === 'failed');

        return {
          total,
          processedCount: processed.length,
          processingCount: processing.length,
          failedCount: failed.length
        };
      })
    ]);

    res.json({
      success: true,
      data: {
        transactions: transactionStats,
        discounts: discountStats,
        credits: creditStats,
        refunds: refundStats,
        period,
        groupBy
      }
    });
  } catch (error) {
    logger.error('Error fetching finance reports:', error);
    throw new AppError('Failed to fetch finance reports', 500, 'FINANCE_REPORTS_FETCH_ERROR');
  }
}));

// Export data
router.get('/export/:type', authenticateToken, requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { type } = req.params;
    const { format = 'csv', dateFrom, dateTo } = req.query;

    let data: any[] = [];
    let filename = '';

    switch (type) {
      case 'transactions':
        data = await safePrismaQuery(async (client) => {
          return await client.transaction.findMany({
            where: {
              ...(dateFrom && dateTo ? {
                createdAt: {
                  gte: new Date(dateFrom as string),
                  lte: new Date(dateTo as string)
                }
              } : {})
            },
            include: {
              parent: { select: { firstName: true, lastName: true, email: true } },
              booking: { 
                select: { 
                  activity: { select: { title: true } },
                  child: { select: { firstName: true, lastName: true } }
                }
              }
            },
            orderBy: { createdAt: 'desc' }
          });
        });
        filename = `transactions_${new Date().toISOString().split('T')[0]}.${format}`;
        break;

      case 'refunds':
        data = await safePrismaQuery(async (client) => {
          return await client.refund.findMany({
            where: {
              ...(dateFrom && dateTo ? {
                createdAt: {
                  gte: new Date(dateFrom as string),
                  lte: new Date(dateTo as string)
                }
              } : {})
            },
            include: {
              parent: { select: { firstName: true, lastName: true, email: true } },
              transaction: { select: { id: true, amount: true } },
              booking: { 
                select: { 
                  activity: { select: { title: true } }
                }
              }
            },
            orderBy: { createdAt: 'desc' }
          });
        });
        filename = `refunds_${new Date().toISOString().split('T')[0]}.${format}`;
        break;

      default:
        throw new AppError('Invalid export type', 400, 'INVALID_EXPORT_TYPE');
    }

    if (format === 'csv') {
      // Convert to CSV format
      const csv = convertToCSV(data);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } else {
      res.json({
        success: true,
        data,
        filename
      });
    }
  } catch (error) {
    logger.error('Error exporting data:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to export data', 500, 'EXPORT_ERROR');
  }
}));

// Helper function to convert data to CSV
function convertToCSV(data: any[]): string {
  if (data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const csvRows = [headers.join(',')];
  
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return `"${String(value).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }
  
  return csvRows.join('\n');
}

export default router;
