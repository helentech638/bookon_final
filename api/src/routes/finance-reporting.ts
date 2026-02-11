import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';
import PaymentRoutingService from '../services/paymentRoutingService';

const router = Router();

// Get finance reporting data
router.get('/reporting', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { 
      range = 'month',
      startDate,
      endDate,
      venueId,
      businessAccountId
    } = req.query;
    
    logger.info('Finance reporting requested', { 
      user: req.user?.email,
      range,
      venueId,
      businessAccountId,
      userId 
    });

    // Calculate date range
    let dateFilter: any = {};
    const now = new Date();
    
    switch (range) {
      case 'today':
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateFilter = {
          gte: today,
          lt: tomorrow
        };
        break;
      case 'week':
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        dateFilter = {
          gte: weekStart
        };
        break;
      case 'month':
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFilter = {
          gte: monthStart
        };
        break;
      case 'custom':
        if (startDate && endDate) {
          dateFilter = {
            gte: new Date(startDate as string),
            lte: new Date(endDate as string)
          };
        }
        break;
    }

    // Build where clause
    const whereClause: any = {
      createdAt: dateFilter,
      status: 'completed'
    };

    if (venueId) {
      whereClause.venueId = venueId;
    }

    if (businessAccountId) {
      whereClause.venue = {
        businessAccountId: businessAccountId
      };
    }

    // Get transactions with payment breakdowns
    const transactions = await safePrismaQuery(async (client) => {
      const bookings = await client.booking.findMany({
        where: whereClause,
        include: {
          activity: {
            include: {
              venue: {
                include: {
                  businessAccount: true
                }
              }
            }
          },
          payments: {
            where: {
              status: 'completed'
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      // Process transactions and get payment breakdowns
      const transactionBreakdowns = await Promise.all(
        bookings.map(async (booking) => {
          const payment = booking.payments[0]; // Get the first completed payment
          if (!payment || !payment.stripePaymentIntentId) {
            return null;
          }

          try {
            const breakdown = await PaymentRoutingService.getPaymentBreakdown(payment.stripePaymentIntentId);
            
            return {
              id: booking.id,
              paymentIntentId: payment.stripePaymentIntentId,
              grossAmount: breakdown.grossAmount,
              franchiseFee: breakdown.franchiseFee,
              vatAmount: breakdown.vatAmount,
              adminFee: breakdown.adminFee,
              stripeFee: breakdown.stripeFee,
              netToVenue: breakdown.netToVenue,
              businessAccountName: breakdown.businessAccountName,
              venueName: breakdown.venueName,
              createdAt: booking.createdAt,
              status: payment.status
            };
          } catch (error) {
            console.error(`Error getting breakdown for payment ${payment.stripePaymentIntentId}:`, error);
            return null;
          }
        })
      );

      return transactionBreakdowns.filter(Boolean);
    });

    // Calculate summary
    const summary = transactions.filter(Boolean).reduce((acc, transaction) => {
      if (!transaction) return acc;
      acc.totalGross += transaction.grossAmount;
      acc.totalFranchiseFees += transaction.franchiseFee;
      acc.totalVat += transaction.vatAmount;
      acc.totalAdminFees += transaction.adminFee;
      acc.totalStripeFees += transaction.stripeFee;
      acc.totalNetToVenues += transaction.netToVenue;
      acc.transactionCount += 1;
      return acc;
    }, {
      totalGross: 0,
      totalFranchiseFees: 0,
      totalVat: 0,
      totalAdminFees: 0,
      totalStripeFees: 0,
      totalNetToVenues: 0,
      transactionCount: 0,
      averageTransactionValue: 0
    });

    summary.averageTransactionValue = summary.transactionCount > 0 
      ? summary.totalGross / summary.transactionCount 
      : 0;

    logger.info('Finance reporting data retrieved', { 
      transactionCount: summary.transactionCount,
      totalGross: summary.totalGross 
    });

    res.json({
      success: true,
      data: {
        transactions,
        summary
      }
    });
  } catch (error) {
    logger.error('Error fetching finance reporting data:', error);
    throw error;
  }
}));

// Get franchise fee analytics
router.get('/analytics', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { range = 'month' } = req.query;
    
    logger.info('Franchise fee analytics requested', { 
      user: req.user?.email,
      range,
      userId 
    });

    // Calculate date range
    let dateFilter: any = {};
    const now = new Date();
    
    switch (range) {
      case 'today':
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateFilter = {
          gte: today,
          lt: tomorrow
        };
        break;
      case 'week':
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        dateFilter = {
          gte: weekStart
        };
        break;
      case 'month':
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFilter = {
          gte: monthStart
        };
        break;
    }

    const analytics = await safePrismaQuery(async (client) => {
      // Get business account performance
      const businessAccounts = await client.businessAccount.findMany({
        where: {
          isActive: true
        },
        include: {
          venues: {
            include: {
              activities: {
                include: {
                  bookings: {
                    where: {
                      createdAt: dateFilter,
                      paymentStatus: 'paid'
                    },
                    include: {
                      payments: {
                        where: {
                          status: 'completed'
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });

      // Calculate analytics for each business account
      const accountAnalytics = businessAccounts.map(account => {
        let totalRevenue = 0;
        let totalFranchiseFees = 0;
        let transactionCount = 0;

        account.venues.forEach(venue => {
          venue.activities.forEach(activity => {
            activity.bookings.forEach(booking => {
              const payment = booking.payments[0];
              if (payment) {
                const paymentAmount = Number(payment.amount);
                totalRevenue += paymentAmount;
                transactionCount += 1;
                
                // Calculate franchise fee (simplified)
                const franchiseFeeValue = Number(account.franchiseFeeValue);
                const franchiseFeeRate = account.franchiseFeeType === 'percent' 
                  ? franchiseFeeValue / 100 
                  : franchiseFeeValue / paymentAmount;
                
                totalFranchiseFees += paymentAmount * franchiseFeeRate;
              }
            });
          });
        });

        return {
          businessAccountId: account.id,
          businessAccountName: account.name,
          venueCount: account.venues.length,
          totalRevenue,
          totalFranchiseFees,
          transactionCount,
          averageTransactionValue: transactionCount > 0 ? totalRevenue / transactionCount : 0,
          franchiseFeeRate: account.franchiseFeeType === 'percent' ? account.franchiseFeeValue : null,
          franchiseFeeFixed: account.franchiseFeeType === 'fixed' ? account.franchiseFeeValue : null
        };
      });

      return accountAnalytics.sort((a, b) => b.totalRevenue - a.totalRevenue);
    });

    logger.info('Franchise fee analytics retrieved', { 
      accountCount: analytics.length 
    });

    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    logger.error('Error fetching franchise fee analytics:', error);
    throw error;
  }
}));

export default router;
