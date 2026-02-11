import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { Decimal } from '@prisma/client/runtime/library';

export interface WalletCredit {
  id: string;
  parentId: string;
  providerId: string | null;
  bookingId: string | null;
  amount: number | Decimal;
  usedAmount: number | Decimal;
  expiryDate: Date;
  source: string;
  status: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  usedAt?: Date;
  transactionId?: string;
}

export interface CreditUsage {
  creditId: string;
  amount: number;
  bookingId: string;
  transactionId: string;
}

// Helper function to map Prisma WalletCredit to WalletCredit interface
function mapWalletCredit(credit: any): WalletCredit {
  return {
    id: credit.id,
    parentId: credit.parentId,
    providerId: credit.providerId,
    bookingId: credit.bookingId,
    amount: credit.amount,
    usedAmount: credit.usedAmount,
    expiryDate: credit.expiryDate,
    source: credit.source,
    status: credit.status,
    description: credit.description ?? undefined,
    createdAt: credit.createdAt,
    updatedAt: credit.updatedAt,
    usedAt: credit.usedAt ?? undefined,
    transactionId: credit.transactionId ?? undefined
  };
}

export interface WalletBalance {
  totalCredits: number;
  availableCredits: number;
  usedCredits: number;
  expiredCredits: number;
  creditsByProvider: Record<string, number>;
  credits: WalletCredit[];
}

class WalletService {
  /**
   * Get wallet balance for a parent
   */
  async getWalletBalance(parentId: string, providerId?: string): Promise<WalletBalance> {
    try {
      const whereClause: any = {
        parentId,
        status: 'active'
      };

      if (providerId) {
        whereClause.providerId = providerId;
      }

      const credits = await safePrismaQuery(async (client) => {
        try {
          return await client.walletCredit.findMany({
            where: whereClause,
            orderBy: { expiryDate: 'asc' }
          });
        } catch (error: any) {
          logger.error('Database error in getWalletBalance:', error);
          // Return empty result if table doesn't exist or other DB issues
          if (error.code === 'P2021' || error.message?.includes('does not exist')) {
            return [];
          }
          throw error;
        }
      });

      const now = new Date();
      const activeCredits = credits.filter(credit => credit.expiryDate > now);
      const expiredCredits = credits.filter(credit => credit.expiryDate <= now);

      const totalCredits = credits.reduce((sum, credit) => sum + Number(credit.amount), 0);
      const usedCredits = credits.reduce((sum, credit) => sum + Number(credit.usedAmount), 0);
      const availableCredits = activeCredits.reduce((sum, credit) => 
        sum + Number(credit.amount) - Number(credit.usedAmount), 0
      );
      const expiredCreditsAmount = expiredCredits.reduce((sum, credit) => 
        sum + Number(credit.amount) - Number(credit.usedAmount), 0
      );

      // Group credits by provider
      const creditsByProvider: Record<string, number> = {};
      activeCredits.forEach(credit => {
        const provider = credit.providerId || 'general';
        creditsByProvider[provider] = (creditsByProvider[provider] || 0) + 
          (Number(credit.amount) - Number(credit.usedAmount));
      });

      return {
        totalCredits,
        availableCredits,
        usedCredits,
        expiredCredits: expiredCreditsAmount,
        creditsByProvider,
        credits: activeCredits.map(mapWalletCredit)
      };
    } catch (error) {
      logger.error('Error getting wallet balance:', error);
      throw error;
    }
  }

  /**
   * Use credits for a booking
   */
  async useCredits(parentId: string, amount: number, bookingId: string, transactionId: string): Promise<CreditUsage[]> {
    try {
      const balance = await this.getWalletBalance(parentId);
      
      if (balance.availableCredits < amount) {
        throw new AppError('Insufficient credits available', 400, 'INSUFFICIENT_CREDITS');
      }

      const creditsToUse = balance.credits.filter(credit => 
        Number(credit.amount) - Number(credit.usedAmount) > 0
      );

      const usage: CreditUsage[] = [];
      let remainingAmount = amount;

      for (const credit of creditsToUse) {
        if (remainingAmount <= 0) break;

        const availableAmount = Number(credit.amount) - Number(credit.usedAmount);
        const useAmount = Math.min(availableAmount, remainingAmount);

        // Update credit usage
        await prisma.walletCredit.update({
          where: { id: credit.id },
          data: {
            usedAmount: Number(credit.usedAmount) + useAmount,
            usedAt: new Date(),
            transactionId,
            updatedAt: new Date()
          }
        });

        usage.push({
          creditId: credit.id,
          amount: useAmount,
          bookingId,
          transactionId
        });

        remainingAmount -= useAmount;
      }

      if (remainingAmount > 0) {
        throw new AppError('Failed to use all requested credits', 500, 'CREDIT_USAGE_ERROR');
      }

      logger.info('Credits used successfully', {
        parentId,
        amount,
        bookingId,
        transactionId,
        creditsUsed: usage.length
      });

      return usage;
    } catch (error) {
      logger.error('Error using credits:', error);
      throw error;
    }
  }

  /**
   * Issue new credit with enhanced expiry management
   */
  async issueCredit(
    parentId: string,
    amount: number,
    source: string,
    providerId?: string,
    bookingId?: string,
    description?: string,
    expiryMonths: number = 12
  ): Promise<WalletCredit> {
    try {
      const expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + expiryMonths);

      const credit = await prisma.walletCredit.create({
        data: {
          parentId,
          providerId: providerId || null,
          bookingId: bookingId || null,
          amount,
          usedAmount: 0,
          expiryDate,
          source,
          status: 'active',
          description: description || `Credit from ${source}`
        }
      });

      logger.info('Credit issued successfully', {
        parentId,
        amount,
        source,
        providerId,
        bookingId,
        creditId: credit.id
      });

      return mapWalletCredit(credit);
    } catch (error) {
      logger.error('Error issuing credit:', error);
      throw error;
    }
  }


  /**
   * Send expiry reminders for credits
   */
  async sendExpiryReminders(): Promise<{ remindersSent: number; errors: number }> {
    try {
      const expiringCredits = await this.getExpiringCredits(30); // 30 days before expiry
      let remindersSent = 0;
      let errors = 0;

      for (const credit of expiringCredits) {
        try {
          // TODO: Implement email service integration
          // This would send a reminder email to the parent with:
          // - Credit amount
          // - Expiry date
          // - Remaining balance
          // - Link to use credits
          
          logger.info('Credit expiry reminder would be sent', {
            creditId: credit.id,
            parentEmail: 'Unknown', // TODO: Get parent email from parentId
            amount: credit.amount,
            expiryDate: credit.expiryDate,
            daysUntilExpiry: Math.ceil((credit.expiryDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
          });
          
          remindersSent++;
        } catch (error) {
          errors++;
          logger.error('Error sending expiry reminder:', {
            creditId: credit.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      logger.info('Credit expiry reminder process completed', {
        totalExpiring: expiringCredits.length,
        remindersSent,
        errors
      });

      return { remindersSent, errors };
    } catch (error) {
      logger.error('Error in expiry reminder process:', error);
      throw error;
    }
  }


  /**
   * Get wallet analytics for admin dashboard
   */
  async getWalletAnalytics(providerId?: string): Promise<{
    totalCreditsIssued: number;
    totalCreditsUsed: number;
    totalCreditsExpired: number;
    activeCreditsBalance: number;
    creditsBySource: Record<string, number>;
    creditsByProvider: Record<string, number>;
    expiringCredits: number;
  }> {
    try {
      const whereClause: any = {};
      if (providerId) {
        whereClause.providerId = providerId;
      }

      const credits = await prisma.walletCredit.findMany({
        where: whereClause,
        include: {
          parent: true
        }
      });

      const now = new Date();
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const analytics = {
        totalCreditsIssued: credits.reduce((sum, c) => sum + Number(c.amount), 0),
        totalCreditsUsed: credits.reduce((sum, c) => sum + Number(c.usedAmount), 0),
        totalCreditsExpired: credits.filter(c => c.status === 'expired').reduce((sum, c) => sum + Number(c.amount), 0),
        activeCreditsBalance: credits.filter(c => c.status === 'active').reduce((sum, c) => sum + Number(c.amount) - Number(c.usedAmount), 0),
        creditsBySource: {} as Record<string, number>,
        creditsByProvider: {} as Record<string, number>,
        expiringCredits: credits.filter(c => 
          c.status === 'active' && 
          c.expiryDate <= thirtyDaysFromNow && 
          c.expiryDate > now
        ).reduce((sum, c) => sum + Number(c.amount) - Number(c.usedAmount), 0)
      };

      // Group by source
      credits.forEach(credit => {
        analytics.creditsBySource[credit.source] = 
          (analytics.creditsBySource[credit.source] || 0) + Number(credit.amount);
      });

      // Group by provider
      credits.forEach(credit => {
        const provider = credit.providerId || 'general';
        analytics.creditsByProvider[provider] = 
          (analytics.creditsByProvider[provider] || 0) + Number(credit.amount);
      });

      return analytics;
    } catch (error) {
      logger.error('Error getting wallet analytics:', error);
      throw error;
    }
  }

  /**
   * Transfer credits between providers
   */
  async transferCredits(
    parentId: string,
    fromProviderId: string,
    toProviderId: string,
    amount: number
  ): Promise<{ fromCredit: WalletCredit | undefined; toCredit: WalletCredit }> {
    try {
      const balance = await this.getWalletBalance(parentId, fromProviderId);
      
      if (balance.availableCredits < amount) {
        throw new AppError('Insufficient credits for transfer', 400, 'INSUFFICIENT_CREDITS');
      }

      // Use credits from source provider
      const usage = await this.useCredits(parentId, amount, 'transfer', `transfer-${Date.now()}`);
      
      // Issue credits to destination provider
      const toCredit = await this.issueCredit(
        parentId,
        amount,
        'transfer',
        toProviderId,
        undefined,
        `Transfer from ${fromProviderId}`,
        12
      );

      const fromCreditRecord = await prisma.walletCredit.findUnique({
        where: { id: usage[0]?.creditId || '' }
      });

      logger.info('Credits transferred successfully', {
        parentId,
        fromProviderId,
        toProviderId,
        amount,
        fromCreditId: fromCreditRecord?.id,
        toCreditId: toCredit.id
      });

      return { 
        fromCredit: fromCreditRecord ? mapWalletCredit(fromCreditRecord) : undefined, 
        toCredit: mapWalletCredit(toCredit) 
      };
    } catch (error) {
      logger.error('Error transferring credits:', error);
      throw error;
    }
  }

  /**
   * Get credits expiring soon
   */
  async getExpiringCredits(daysAhead: number = 30): Promise<WalletCredit[]> {
    try {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + daysAhead);

      const credits = await prisma.walletCredit.findMany({
        where: {
          status: 'active',
          expiryDate: {
            lte: expiryDate,
            gte: new Date()
          },
          usedAmount: {
            lt: prisma.walletCredit.fields.amount
          }
        },
        include: {
          parent: {
            select: {
              firstName: true,
              lastName: true,
              email: true
            }
          }
        },
        orderBy: { expiryDate: 'asc' }
      });

      return credits.map((credit: any) => mapWalletCredit(credit));
    } catch (error) {
      logger.error('Error getting expiring credits:', error);
      throw error;
    }
  }

  /**
   * Process expired credits
   */
  async processExpiredCredits(): Promise<number> {
    try {
      const now = new Date();
      
      const expiredCredits = await prisma.walletCredit.updateMany({
        where: {
          status: 'active',
          expiryDate: {
            lt: now
          }
        },
        data: {
          status: 'expired',
          updatedAt: now
        }
      });

      if (expiredCredits.count > 0) {
        logger.info(`Processed ${expiredCredits.count} expired credits`);
      }

      return expiredCredits.count;
    } catch (error) {
      logger.error('Error processing expired credits:', error);
      throw error;
    }
  }

  /**
   * Get credit history for a parent
   */
  async getCreditHistory(parentId: string, limit: number = 50): Promise<WalletCredit[]> {
    try {
      const credits = await prisma.walletCredit.findMany({
        where: { parentId },
        orderBy: { createdAt: 'desc' },
        take: limit
      });

      return credits.map((credit: any) => mapWalletCredit(credit));
    } catch (error) {
      logger.error('Error getting credit history:', error);
      throw error;
    }
  }

  /**
   * Get wallet statistics for admin
   */
  async getWalletStats(providerId?: string): Promise<{
    totalCreditsIssued: number;
    totalCreditsUsed: number;
    totalCreditsExpired: number;
    activeCredits: number;
    creditsBySource: Record<string, number>;
    creditsByProvider: Record<string, number>;
  }> {
    try {
      const whereClause: any = {};
      if (providerId) {
        whereClause.providerId = providerId;
      }

      const credits = await prisma.walletCredit.findMany({
        where: whereClause
      });

      const stats = {
        totalCreditsIssued: credits.reduce((sum, c) => sum + Number(c.amount), 0),
        totalCreditsUsed: credits.reduce((sum, c) => sum + Number(c.usedAmount), 0),
        totalCreditsExpired: 0,
        activeCredits: 0,
        creditsBySource: {} as Record<string, number>,
        creditsByProvider: {} as Record<string, number>
      };

      const now = new Date();
      
      credits.forEach(credit => {
        // Count by source
        stats.creditsBySource[credit.source] = 
          (stats.creditsBySource[credit.source] || 0) + Number(credit.amount);
        
        // Count by provider
        const provider = credit.providerId || 'general';
        stats.creditsByProvider[provider] = 
          (stats.creditsByProvider[provider] || 0) + Number(credit.amount);
        
        // Count active vs expired
        if (credit.expiryDate > now && credit.status === 'active') {
          stats.activeCredits += Number(credit.amount) - Number(credit.usedAmount);
        } else if (credit.expiryDate <= now || credit.status === 'expired') {
          stats.totalCreditsExpired += Number(credit.amount) - Number(credit.usedAmount);
        }
      });

      return stats;
    } catch (error) {
      logger.error('Error getting wallet stats:', error);
      throw error;
    }
  }
}

export const walletService = new WalletService();
