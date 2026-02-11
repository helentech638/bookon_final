import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

export interface DataRetentionPolicy {
  userData: number; // days
  bookingData: number; // days
  auditLogs: number; // days
  webhookEvents: number; // days
  notificationData: number; // days
  expiredCredits: number; // days
}

export class DataRetentionService {
  private defaultPolicy: DataRetentionPolicy = {
    userData: 2555, // 7 years (GDPR requirement)
    bookingData: 2555, // 7 years (financial records)
    auditLogs: 2555, // 7 years (compliance)
    webhookEvents: 365, // 1 year
    notificationData: 90, // 3 months
    expiredCredits: 365 // 1 year
  };

  /**
   * Clean up expired data based on retention policies
   */
  async cleanupExpiredData(policy?: Partial<DataRetentionPolicy>): Promise<{
    deletedRecords: Record<string, number>;
    errors: string[];
  }> {
    const retentionPolicy = { ...this.defaultPolicy, ...policy };
    const deletedRecords: Record<string, number> = {};
    const errors: string[] = [];

    logger.info('Starting data retention cleanup', { policy: retentionPolicy });

    try {
      // Clean up expired webhook events
      const webhookCutoff = new Date();
      webhookCutoff.setDate(webhookCutoff.getDate() - retentionPolicy.webhookEvents);
      
      const deletedWebhooks = await prisma.webhookEvent.deleteMany({
        where: {
          createdAt: {
            lt: webhookCutoff
          }
        }
      });
      deletedRecords.webhookEvents = deletedWebhooks.count;
      logger.info(`Deleted ${deletedWebhooks.count} expired webhook events`);

    } catch (error) {
      const errorMsg = `Error cleaning webhook events: ${error}`;
      errors.push(errorMsg);
      logger.error(errorMsg, error);
    }

    try {
      // Clean up old notifications (keep only recent ones)
      const notificationCutoff = new Date();
      notificationCutoff.setDate(notificationCutoff.getDate() - retentionPolicy.notificationData);
      
      const deletedNotifications = await prisma.notification.deleteMany({
        where: {
          createdAt: {
            lt: notificationCutoff
          },
          read: true // Only delete read notifications
        }
      });
      deletedRecords.notifications = deletedNotifications.count;
      logger.info(`Deleted ${deletedNotifications.count} old notifications`);

    } catch (error) {
      const errorMsg = `Error cleaning notifications: ${error}`;
      errors.push(errorMsg);
      logger.error(errorMsg, error);
    }

    try {
      // Clean up expired wallet credits
      const creditCutoff = new Date();
      creditCutoff.setDate(creditCutoff.getDate() - retentionPolicy.expiredCredits);
      
      const deletedCredits = await prisma.walletCredit.deleteMany({
        where: {
          status: 'expired',
          updatedAt: {
            lt: creditCutoff
          }
        }
      });
      deletedRecords.walletCredits = deletedCredits.count;
      logger.info(`Deleted ${deletedCredits.count} expired wallet credits`);

    } catch (error) {
      const errorMsg = `Error cleaning wallet credits: ${error}`;
      errors.push(errorMsg);
      logger.error(errorMsg, error);
    }

    try {
      // Clean up old audit logs (keep only recent ones for compliance)
      const auditCutoff = new Date();
      auditCutoff.setDate(auditCutoff.getDate() - retentionPolicy.auditLogs);
      
      const deletedAuditLogs = await prisma.auditLog.deleteMany({
        where: {
          timestamp: {
            lt: auditCutoff
          }
        }
      });
      deletedRecords.auditLogs = deletedAuditLogs.count;
      logger.info(`Deleted ${deletedAuditLogs.count} old audit logs`);

    } catch (error) {
      const errorMsg = `Error cleaning audit logs: ${error}`;
      errors.push(errorMsg);
      logger.error(errorMsg, error);
    }

    logger.info('Data retention cleanup completed', { 
      deletedRecords, 
      errorCount: errors.length 
    });

    return { deletedRecords, errors };
  }

  /**
   * Anonymize user data instead of deleting (for GDPR compliance)
   */
  async anonymizeUserData(userId: string): Promise<void> {
    try {
      logger.info('Anonymizing user data', { userId });

      // Anonymize user record
      await prisma.user.update({
        where: { id: userId },
        data: {
          email: `anonymized_${userId}@deleted.local`,
          firstName: 'Anonymized',
          lastName: 'User',
          phone: null,
          stripeCustomerId: null,
          isActive: false,
          updatedAt: new Date()
        }
      });

      // Anonymize children records
      await prisma.child.updateMany({
        where: { parentId: userId },
        data: {
          firstName: 'Anonymized',
          lastName: 'Child',
          allergies: null,
          updatedAt: new Date()
        }
      });

      // Anonymize audit logs
      await prisma.auditLog.updateMany({
        where: { userId },
        data: {
          userId: 'anonymized',
          userRole: 'anonymized'
        }
      });

      logger.info('User data anonymized successfully', { userId });

    } catch (error) {
      logger.error('Error anonymizing user data:', error);
      throw error;
    }
  }

  /**
   * Get data retention statistics
   */
  async getRetentionStats(): Promise<{
    totalUsers: number;
    inactiveUsers: number;
    oldBookings: number;
    oldAuditLogs: number;
    oldWebhookEvents: number;
    oldNotifications: number;
    expiredCredits: number;
  }> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 365); // 1 year ago

      const [
        totalUsers,
        inactiveUsers,
        oldBookings,
        oldAuditLogs,
        oldWebhookEvents,
        oldNotifications,
        expiredCredits
      ] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isActive: false } }),
        prisma.booking.count({ 
          where: { 
            createdAt: { lt: cutoffDate },
            status: 'completed'
          } 
        }),
        prisma.auditLog.count({ 
          where: { 
            timestamp: { lt: cutoffDate } 
          } 
        }),
        prisma.webhookEvent.count({ 
          where: { 
            createdAt: { lt: cutoffDate } 
          } 
        }),
        prisma.notification.count({ 
          where: { 
            createdAt: { lt: cutoffDate },
            read: true
          } 
        }),
        prisma.walletCredit.count({ 
          where: { 
            status: 'expired',
            updatedAt: { lt: cutoffDate }
          } 
        })
      ]);

      return {
        totalUsers,
        inactiveUsers,
        oldBookings,
        oldAuditLogs,
        oldWebhookEvents,
        oldNotifications,
        expiredCredits
      };

    } catch (error) {
      logger.error('Error getting retention stats:', error);
      throw error;
    }
  }

  /**
   * Export user data for GDPR compliance
   */
  async exportUserData(userId: string): Promise<{
    user: any;
    children: any[];
    bookings: any[];
    notifications: any[];
    walletCredits: any[];
  }> {
    try {
      logger.info('Exporting user data for GDPR compliance', { userId });

      const [user, children, bookings, notifications, walletCredits] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            phone: true,
            createdAt: true,
            updatedAt: true,
            lastLoginAt: true
          }
        }),
        prisma.child.findMany({
          where: { parentId: userId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            yearGroup: true,
            allergies: true,
            createdAt: true,
            updatedAt: true
          }
        }),
        prisma.booking.findMany({
          where: { parentId: userId },
          include: {
            activity: {
              include: {
                venue: true
              }
            },
            child: true
          }
        }),
        prisma.notification.findMany({
          where: { userId },
          select: {
            id: true,
            type: true,
            title: true,
            message: true,
            priority: true,
            read: true,
            createdAt: true,
            readAt: true
          }
        }),
        prisma.walletCredit.findMany({
          where: { parentId: userId },
          select: {
            id: true,
            amount: true,
            usedAmount: true,
            expiryDate: true,
            source: true,
            status: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            usedAt: true
          }
        })
      ]);

      if (!user) {
        throw new Error('User not found');
      }

      logger.info('User data exported successfully', { 
        userId, 
        childrenCount: children.length,
        bookingsCount: bookings.length,
        notificationsCount: notifications.length,
        creditsCount: walletCredits.length
      });

      return {
        user,
        children,
        bookings,
        notifications,
        walletCredits
      };

    } catch (error) {
      logger.error('Error exporting user data:', error);
      throw error;
    }
  }

  /**
   * Delete user data completely (GDPR right to be forgotten)
   */
  async deleteUserData(userId: string): Promise<void> {
    try {
      logger.info('Deleting user data for GDPR compliance', { userId });

      // Delete registers for activities that have bookings from this user's children
      // First get all activityIds from bookings for this user's children
      const userChildren = await prisma.child.findMany({
        where: { parentId: userId },
        select: { id: true }
      });
      const childIds = userChildren.map(c => c.id);
      
      if (childIds.length > 0) {
        const bookings = await prisma.booking.findMany({
          where: { childId: { in: childIds } },
          select: { activityId: true }
        });
        const activityIds = [...new Set(bookings.map(b => b.activityId))];
        
        if (activityIds.length > 0) {
          await prisma.register.deleteMany({
            where: {
              activityId: { in: activityIds }
            }
          });
        }
      }

      await prisma.walletCredit.deleteMany({
        where: { parentId: userId }
      });

      await prisma.refundTransaction.deleteMany({
        where: {
          booking: {
            parentId: userId
          }
        }
      });

      await prisma.booking.deleteMany({
        where: { parentId: userId }
      });

      await prisma.child.deleteMany({
        where: { parentId: userId }
      });

      await prisma.notification.deleteMany({
        where: { userId }
      });

      await prisma.auditLog.deleteMany({
        where: { userId }
      });

      await prisma.user.delete({
        where: { id: userId }
      });

      logger.info('User data deleted successfully', { userId });

    } catch (error) {
      logger.error('Error deleting user data:', error);
      throw error;
    }
  }
}

export const dataRetentionService = new DataRetentionService();

