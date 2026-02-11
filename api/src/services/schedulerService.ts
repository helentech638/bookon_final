import cron from 'node-cron';
import { logger } from '../utils/logger';
import { tfcService } from './tfcService';
import { walletService } from './walletService';

interface JobInfo {
  task: cron.ScheduledTask;
  cronExpression: string;
  lastRun?: Date;
  running: boolean;
}

class SchedulerService {
  private jobs: Map<string, cron.ScheduledTask> = new Map();
  private jobInfo: Map<string, JobInfo> = new Map();

  /**
   * Initialize all scheduled jobs
   */
  initializeScheduledJobs(): void {
    logger.info('Initializing scheduled jobs...');

    // TFC Auto-cancellation - Run every hour
    this.scheduleJob('tfc-auto-cancel', '0 * * * *', async () => {
      try {
        logger.info('Running TFC auto-cancellation job...');
        const result = await tfcService.autoCancelExpiredTFCBookings();
        logger.info('TFC auto-cancellation completed', result);
      } catch (error) {
        logger.error('TFC auto-cancellation job failed:', error);
      }
    });

    // TFC Payment Reminders - Run every 6 hours
    this.scheduleJob('tfc-reminders', '0 */6 * * *', async () => {
      try {
        logger.info('Running TFC payment reminders job...');
        const result = await tfcService.sendTFCPaymentReminders();
        logger.info('TFC payment reminders completed', result);
      } catch (error) {
        logger.error('TFC payment reminders job failed:', error);
      }
    });

    // Credit Expiry Reminders - Run daily at 9 AM
    this.scheduleJob('credit-expiry-reminders', '0 9 * * *', async () => {
      try {
        logger.info('Running credit expiry reminders job...');
        const result = await walletService.sendExpiryReminders();
        logger.info('Credit expiry reminders completed', result);
      } catch (error) {
        logger.error('Credit expiry reminders job failed:', error);
      }
    });

    // Process Expired Credits - Run daily at midnight
    this.scheduleJob('process-expired-credits', '0 0 * * *', async () => {
      try {
        logger.info('Running expired credits processing job...');
        const result = await walletService.processExpiredCredits();
        logger.info('Expired credits processing completed', result);
      } catch (error) {
        logger.error('Expired credits processing job failed:', error);
      }
    });

    // Cleanup old notifications - Run weekly on Sunday at 2 AM
    this.scheduleJob('cleanup-notifications', '0 2 * * 0', async () => {
      try {
        logger.info('Running notification cleanup job...');
        await this.cleanupOldNotifications();
        logger.info('Notification cleanup completed');
      } catch (error) {
        logger.error('Notification cleanup job failed:', error);
      }
    });

    logger.info('All scheduled jobs initialized successfully');
  }

  /**
   * Schedule a new job
   */
  private scheduleJob(name: string, cronExpression: string, task: () => Promise<void>): void {
    if (this.jobs.has(name)) {
      logger.warn(`Job ${name} already exists, stopping previous instance`);
      this.jobs.get(name)?.stop();
    }

    const wrappedTask = async () => {
      const info = this.jobInfo.get(name);
      if (info) {
        info.running = true;
        info.lastRun = new Date();
      }
      try {
        await task();
      } finally {
        if (info) {
          info.running = false;
        }
      }
    };

    const job = cron.schedule(cronExpression, wrappedTask, {
      scheduled: true,
      timezone: 'Europe/London'
    });

    this.jobs.set(name, job);
    this.jobInfo.set(name, {
      task: job,
      cronExpression,
      running: false
    });
    logger.info(`Scheduled job: ${name} (${cronExpression})`);
  }

  /**
   * Stop a specific job
   */
  stopJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.jobs.delete(name);
      logger.info(`Stopped job: ${name}`);
      return true;
    }
    logger.warn(`Job ${name} not found`);
    return false;
  }

  /**
   * Stop all jobs
   */
  stopAllJobs(): void {
    logger.info('Stopping all scheduled jobs...');
    this.jobs.forEach((job, name) => {
      job.stop();
      logger.info(`Stopped job: ${name}`);
    });
    this.jobs.clear();
    logger.info('All scheduled jobs stopped');
  }

  /**
   * Get job status
   */
  getJobStatus(): Array<{ name: string; running: boolean; lastRun?: Date; cronExpression: string }> {
    const status: Array<{ name: string; running: boolean; lastRun?: Date; cronExpression: string }> = [];
    
    this.jobInfo.forEach((info, name) => {
      status.push({
        name,
        running: info.running,
        lastRun: info.lastRun,
        cronExpression: info.cronExpression
      });
    });

    return status;
  }

  /**
   * Run a job manually (for testing)
   */
  async runJobManually(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      logger.info(`Manually running job: ${name}`);
      
      switch (name) {
        case 'tfc-auto-cancel':
          await tfcService.autoCancelExpiredTFCBookings();
          break;
        case 'tfc-reminders':
          await tfcService.sendTFCPaymentReminders();
          break;
        case 'credit-expiry-reminders':
          await walletService.sendExpiryReminders();
          break;
        case 'process-expired-credits':
          await walletService.processExpiredCredits();
          break;
        case 'cleanup-notifications':
          await this.cleanupOldNotifications();
          break;
        default:
          throw new Error(`Unknown job: ${name}`);
      }

      logger.info(`Manual job ${name} completed successfully`);
      return { success: true };
    } catch (error) {
      logger.error(`Manual job ${name} failed:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Cleanup old notifications (older than 90 days)
   */
  private async cleanupOldNotifications(): Promise<void> {
    try {
      const { prisma } = await import('../utils/prisma');
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const { safePrismaQuery } = await import('../utils/prisma');
      const result = await safePrismaQuery(async (client) => {
        return await client.notification.deleteMany({
          where: {
            createdAt: {
              lt: ninetyDaysAgo
            },
            read: true // Only delete read notifications
          }
        });
      });

      logger.info(`Cleaned up ${result.count} old notifications`);
    } catch (error) {
      logger.error('Error cleaning up notifications:', error);
      throw error;
    }
  }

  /**
   * Health check for scheduled jobs
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    jobs: Array<{ name: string; status: string; lastRun?: Date; cronExpression: string }>;
    errors: string[];
  }> {
    const jobs = this.getJobStatus();
    const errors: string[] = [];
    let unhealthyJobs = 0;

    jobs.forEach(job => {
      // Check if job exists in the jobs map (means it's scheduled)
      if (!this.jobs.has(job.name)) {
        unhealthyJobs++;
        errors.push(`Job ${job.name} is not scheduled`);
      }
    });

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (unhealthyJobs === 0) {
      status = 'healthy';
    } else if (unhealthyJobs < jobs.length / 2) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      jobs: jobs.map(job => ({
        name: job.name,
        status: job.running ? 'running' : 'scheduled',
        lastRun: job.lastRun,
        cronExpression: job.cronExpression
      })),
      errors
    };
  }
}

export const schedulerService = new SchedulerService();
