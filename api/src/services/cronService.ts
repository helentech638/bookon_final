import { logger } from '../utils/logger';
import { notificationAutomationService } from './notificationAutomationService';
import { walletService } from './walletService';
import { prisma } from '../utils/prisma';

class CronService {
  private isRunning = false;

  /**
   * Start the cron service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Cron service is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting cron service');

    // Run every 5 minutes
    setInterval(() => {
      this.runScheduledTasks();
    }, 5 * 60 * 1000);

    // Run immediately on startup
    this.runScheduledTasks();
  }

  /**
   * Stop the cron service
   */
  stop(): void {
    this.isRunning = false;
    logger.info('Cron service stopped');
  }

  /**
   * Run all scheduled tasks
   */
  private async runScheduledTasks(): Promise<void> {
    try {
      await Promise.all([
        this.processTFCReminders(),
        this.processCreditExpiryReminders(),
        this.processExpiredCredits(),
        this.processScheduledNotifications()
      ]);
    } catch (error) {
      logger.error('Error running scheduled tasks:', error);
    }
  }

  /**
   * Process TFC payment reminders
   */
  private async processTFCReminders(): Promise<void> {
    try {
      const now = new Date();
      const reminderTime = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours from now

      // Find TFC bookings that need reminders
      const bookingsNeedingReminders = await prisma.booking.findMany({
        where: {
          paymentStatus: 'pending_payment',
          paymentMethod: 'tfc',
          tfcDeadline: {
            lte: reminderTime,
            gte: now
          }
        },
        include: {
          child: true,
          activity: {
            include: {
              venue: true
            }
          },
          parent: true
        }
      });

      for (const booking of bookingsNeedingReminders) {
        try {
          // Check if reminder already sent
          const existingReminder = await prisma.notification.findFirst({
            where: {
              userId: booking.parentId,
              type: 'tfc_payment_reminder',
              data: {
                path: ['bookingData', 'reference'],
                equals: booking.tfcReference || undefined
              }
            }
          });

          if (existingReminder) {
            continue; // Reminder already sent
          }

          const daysRemaining = Math.ceil(
            (new Date(booking.tfcDeadline!).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );

          await notificationAutomationService.sendTFCPaymentReminder(
            booking.parentId,
            {
              reference: booking.tfcReference!,
              deadline: new Date(booking.tfcDeadline!),
              amount: Number(booking.amount),
              child: `${booking.child.firstName} ${booking.child.lastName}`,
              activity: booking.activity.title,
              venue: booking.activity.venue.name,
              daysRemaining
            }
          );

          logger.info('TFC reminder sent', {
            bookingId: booking.id,
            reference: booking.tfcReference,
            daysRemaining
          });
        } catch (error) {
          logger.error(`Error sending TFC reminder for booking ${booking.id}:`, error);
        }
      }

      if (bookingsNeedingReminders.length > 0) {
        logger.info(`Processed ${bookingsNeedingReminders.length} TFC reminders`);
      }
    } catch (error) {
      logger.error('Error processing TFC reminders:', error);
    }
  }

  /**
   * Process credit expiry reminders
   */
  private async processCreditExpiryReminders(): Promise<void> {
    try {
      const now = new Date();
      const reminderDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

      // Find credits expiring in 30 days
      const expiringCredits = await walletService.getExpiringCredits(30);

      for (const credit of expiringCredits) {
        try {
          // Check if reminder already sent
          const existingReminder = await prisma.notification.findFirst({
            where: {
              userId: credit.parentId,
              type: 'credit_expiry_reminder',
              data: {
                path: ['creditData', 'creditId'],
                equals: credit.id
              }
            }
          });

          if (existingReminder) {
            continue; // Reminder already sent
          }

          const daysUntilExpiry = Math.ceil(
            (new Date(credit.expiryDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );

          await notificationAutomationService.sendCreditExpiryReminder(
            credit.parentId,
            {
              creditId: credit.id,
              amount: Number(credit.amount),
              expiryDate: new Date(credit.expiryDate),
              daysUntilExpiry
            }
          );

          logger.info('Credit expiry reminder sent', {
            creditId: credit.id,
            parentId: credit.parentId,
            amount: credit.amount,
            daysUntilExpiry
          });
        } catch (error) {
          logger.error(`Error sending credit expiry reminder for credit ${credit.id}:`, error);
        }
      }

      if (expiringCredits.length > 0) {
        logger.info(`Processed ${expiringCredits.length} credit expiry reminders`);
      }
    } catch (error) {
      logger.error('Error processing credit expiry reminders:', error);
    }
  }

  /**
   * Process expired credits
   */
  private async processExpiredCredits(): Promise<void> {
    try {
      const expiredCount = await walletService.processExpiredCredits();
      
      if (expiredCount > 0) {
        logger.info(`Processed ${expiredCount} expired credits`);
      }
    } catch (error) {
      logger.error('Error processing expired credits:', error);
    }
  }

  /**
   * Process scheduled notifications
   */
  private async processScheduledNotifications(): Promise<void> {
    try {
      const processedCount = await notificationAutomationService.processScheduledNotifications();
      
      if (processedCount > 0) {
        logger.info(`Processed ${processedCount} scheduled notifications`);
      }
    } catch (error) {
      logger.error('Error processing scheduled notifications:', error);
    }
  }

  /**
   * Auto-cancel expired TFC bookings
   */
  async processExpiredTFCBookings(): Promise<void> {
    try {
      const now = new Date();

      // Find TFC bookings that have passed their deadline
      const expiredBookings = await prisma.booking.findMany({
        where: {
          paymentStatus: 'pending_payment',
          paymentMethod: 'tfc',
          tfcDeadline: {
            lt: now
          }
        },
        include: {
          child: true,
          activity: {
            include: {
              venue: true
            }
          },
          parent: true
        }
      });

      for (const booking of expiredBookings) {
        try {
          // Cancel the booking
          await prisma.booking.update({
            where: { id: booking.id },
            data: {
              status: 'cancelled',
              paymentStatus: 'failed',
              notes: `Auto-cancelled: TFC payment deadline expired on ${booking.tfcDeadline}`,
              updatedAt: new Date()
            }
          });

          // Send cancellation notification
          await notificationAutomationService.sendCancellationConfirmation(
            booking.parentId,
            {
              bookingId: booking.id,
              child: `${booking.child.firstName} ${booking.child.lastName}`,
              activity: booking.activity.title,
              venue: booking.activity.venue.name,
              refundAmount: 0,
              creditAmount: 0,
              adminFee: 0,
              method: 'credit',
              reason: 'Payment deadline expired'
            }
          );

          logger.info('Expired TFC booking auto-cancelled', {
            bookingId: booking.id,
            reference: booking.tfcReference,
            deadline: booking.tfcDeadline
          });
        } catch (error) {
          logger.error(`Error auto-cancelling expired TFC booking ${booking.id}:`, error);
        }
      }

      if (expiredBookings.length > 0) {
        logger.info(`Auto-cancelled ${expiredBookings.length} expired TFC bookings`);
      }
    } catch (error) {
      logger.error('Error processing expired TFC bookings:', error);
    }
  }

  /**
   * Get cron service status
   */
  getStatus(): { running: boolean; uptime: number } {
    return {
      running: this.isRunning,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }

  private startTime = Date.now();
}

export const cronService = new CronService();
