import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

export interface TFCBookingData {
  bookingId: string;
  amount: number;
  currency?: string;
  venueId: string;
  parentId: string;
  holdPeriod?: number;
}

export interface TFCReference {
  reference: string;
  deadline: Date;
  instructions: string;
}

export interface ProviderTFCConfig {
  tfcEnabled: boolean;
  holdPeriod: number;
  instructions: string;
  payeeDetails: {
    name: string;
    reference: string;
    sortCode?: string;
    accountNumber?: string;
  };
}

class TFCService {
  /**
   * Generate unique TFC payment reference
   * Format: TFC-YYYYMMDD-XXXXXX (6 random digits)
   */
  private generateTFCReference(): string {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    return `TFC-${dateStr}-${randomSuffix}`;
  }

  /**
   * Get provider TFC configuration
   */
  async getProviderTFCConfig(venueId: string): Promise<ProviderTFCConfig> {
    try {
      const settings = await prisma.providerSettings.findUnique({
        where: { providerId: venueId }
      });

      if (!settings || !settings.tfcEnabled) {
        throw new AppError('TFC not enabled for this provider', 400, 'TFC_NOT_ENABLED');
      }

      return {
        tfcEnabled: settings.tfcEnabled,
        holdPeriod: settings.tfcHoldPeriod,
        instructions: settings.tfcInstructions || this.getDefaultInstructions(),
        payeeDetails: {
          name: settings.tfcPayeeName || 'BookOn Platform',
          reference: settings.tfcPayeeReference || 'BOOKON-TFC',
          sortCode: settings.tfcSortCode || '20-00-00',
          accountNumber: settings.tfcAccountNumber || '12345678'
        }
      };
    } catch (error) {
      logger.error('Error getting provider TFC config:', error);
      throw error;
    }
  }

  /**
   * Create TFC booking with pending payment status
   */
  async createTFCBooking(data: TFCBookingData): Promise<TFCReference> {
    try {
      const config = await this.getProviderTFCConfig(data.venueId);
      const reference = this.generateTFCReference();
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + (data.holdPeriod || config.holdPeriod));

      // Update booking with TFC details
      await prisma.booking.update({
        where: { id: data.bookingId },
        data: {
          paymentMethod: 'tfc',
          paymentStatus: 'pending_payment',
          tfcReference: reference,
          tfcDeadline: deadline,
          tfcInstructions: config.instructions,
          holdPeriod: data.holdPeriod || config.holdPeriod,
          updatedAt: new Date()
        }
      });

      logger.info('TFC booking created', {
        bookingId: data.bookingId,
        reference,
        deadline,
        amount: data.amount
      });

      return {
        reference,
        deadline,
        instructions: config.instructions
      };
    } catch (error) {
      logger.error('Error creating TFC booking:', error);
      throw error;
    }
  }

  /**
   * Confirm TFC payment received
   */
  async confirmTFCPayment(bookingId: string, adminId: string): Promise<void> {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { activity: true, child: true, parent: true }
      });

      if (!booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      if (booking.paymentMethod !== 'tfc') {
        throw new AppError('Booking is not a TFC payment', 400, 'NOT_TFC_BOOKING');
      }

      if (booking.paymentStatus !== 'pending_payment') {
        throw new AppError('Booking is not in pending payment status', 400, 'INVALID_STATUS');
      }

      // Update booking status to confirmed
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: 'paid',
          status: 'confirmed',
          updatedAt: new Date()
        }
      });

      logger.info('TFC payment confirmed', {
        bookingId,
        adminId,
        reference: booking.tfcReference,
        amount: booking.amount
      });

      // Send confirmation email to parent
      // TODO: Implement email service
      
      // Update activity capacity - TFC booking is now confirmed
      await this.updateActivityCapacity(booking.activityId, 1);
    } catch (error) {
      logger.error('Error confirming TFC payment:', error);
      throw error;
    }
  }

  /**
   * Auto-cancel expired TFC bookings (scheduled job)
   */
  async autoCancelExpiredTFCBookings(): Promise<{ cancelled: number; errors: number }> {
    try {
      const now = new Date();
      
      // Find all TFC bookings that have passed their deadline
      const expiredBookings = await prisma.booking.findMany({
        where: {
          paymentMethod: 'tfc',
          paymentStatus: 'pending_payment',
          tfcDeadline: {
            lt: now
          }
        },
        include: {
          activity: true,
          child: true,
          parent: true
        }
      });

      let cancelled = 0;
      let errors = 0;

      for (const booking of expiredBookings) {
        try {
          await this.cancelUnpaidTFCBooking(booking.id, 'system', 'Payment deadline exceeded - auto-cancelled');
          cancelled++;
          
          logger.info('Auto-cancelled expired TFC booking', {
            bookingId: booking.id,
            reference: booking.tfcReference,
            deadline: booking.tfcDeadline,
            amount: booking.amount
          });
        } catch (error) {
          errors++;
          logger.error('Error auto-cancelling TFC booking:', {
            bookingId: booking.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      logger.info('TFC auto-cancellation completed', {
        totalExpired: expiredBookings.length,
        cancelled,
        errors
      });

      return { cancelled, errors };
    } catch (error) {
      logger.error('Error in auto-cancellation process:', error);
      throw error;
    }
  }

  /**
   * Send TFC payment reminders (scheduled job)
   */
  async sendTFCPaymentReminders(): Promise<{ remindersSent: number; errors: number }> {
    try {
      const now = new Date();
      const reminderTime = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours from now
      
      // Find TFC bookings that need reminders (deadline in 48 hours)
      const bookingsNeedingReminders = await safePrismaQuery(async (client) => {
        return await client.booking.findMany({
          where: {
            paymentMethod: 'tfc',
            paymentStatus: 'pending_payment',
            tfcDeadline: {
              gte: now,
              lte: reminderTime
            }
          },
          include: {
            activity: {
              include: {
                venue: true
              }
            },
            child: true,
            parent: true
          }
        });
      });

      let remindersSent = 0;
      let errors = 0;

      for (const booking of bookingsNeedingReminders) {
        try {
          // Send reminder email
          await this.sendTFCPaymentReminder(booking);
          remindersSent++;
          
          logger.info('TFC payment reminder sent', {
            bookingId: booking.id,
            reference: booking.tfcReference,
            deadline: booking.tfcDeadline,
            parentEmail: booking.parent.email
          });
        } catch (error) {
          errors++;
          logger.error('Error sending TFC reminder:', {
            bookingId: booking.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      logger.info('TFC reminder process completed', {
        totalNeedingReminders: bookingsNeedingReminders.length,
        remindersSent,
        errors
      });

      return { remindersSent, errors };
    } catch (error) {
      logger.error('Error in TFC reminder process:', error);
      throw error;
    }
  }

  /**
   * Send TFC payment reminder email
   */
  private async sendTFCPaymentReminder(booking: any): Promise<void> {
    // TODO: Implement email service integration
    // This would send a reminder email to the parent with:
    // - Payment reference
    // - Deadline
    // - Amount
    // - Instructions
    // - Link to payment instructions
    
    logger.info('TFC payment reminder email would be sent', {
      bookingId: booking.id,
      parentEmail: booking.parent.email,
      reference: booking.tfcReference,
      deadline: booking.tfcDeadline,
      amount: booking.amount
    });
  }

  /**
   * Cancel unpaid TFC booking
   */
  async cancelUnpaidTFCBooking(bookingId: string, adminId: string, reason: string = 'Payment not received by deadline'): Promise<void> {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId }
      });

      if (!booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      if (booking.paymentMethod !== 'tfc') {
        throw new AppError('Booking is not a TFC payment', 400, 'NOT_TFC_BOOKING');
      }

      // Update booking status to cancelled
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: 'cancelled',
          status: 'cancelled',
          notes: reason,
          updatedAt: new Date()
        }
      });

      logger.info('TFC booking cancelled', {
        bookingId,
        adminId,
        reference: booking.tfcReference,
        reason
      });

      // Send cancellation email to parent
      // TODO: Implement email service
      
      // Free up activity capacity - TFC booking is cancelled
      await this.updateActivityCapacity(booking.activityId, -1);
    } catch (error) {
      logger.error('Error cancelling TFC booking:', error);
      throw error;
    }
  }

  /**
   * Get pending TFC bookings for admin queue
   */
  async getPendingTFCBookings(venueId?: string): Promise<any[]> {
    try {
      const whereClause: any = {
        paymentMethod: 'tfc',
        paymentStatus: 'pending_payment'
      };

      if (venueId) {
        whereClause.activity = {
          venueId: venueId
        };
      }

      const bookings = await prisma.booking.findMany({
        where: whereClause,
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
        },
        orderBy: {
          tfcDeadline: 'asc'
        }
      });

      return bookings.map(booking => ({
        id: booking.id,
        child: `${booking.child.firstName} ${booking.child.lastName}`,
        parent: `${booking.parent.firstName} ${booking.parent.lastName}`,
        parentEmail: booking.parent.email,
        activity: booking.activity.title,
        venue: booking.activity.venue.name,
        venueId: booking.activity.venue.id,
        amount: booking.amount,
        reference: booking.tfcReference,
        deadline: booking.tfcDeadline,
        createdAt: booking.createdAt,
        daysRemaining: booking.tfcDeadline ? 
          Math.ceil((booking.tfcDeadline.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) : 0
      }));
    } catch (error) {
      logger.error('Error getting pending TFC bookings:', error);
      throw error;
    }
  }

  /**
   * Check for expired TFC bookings and auto-cancel them
   */
  async processExpiredTFCBookings(): Promise<number> {
    try {
      const expiredBookings = await prisma.booking.findMany({
        where: {
          paymentMethod: 'tfc',
          paymentStatus: 'pending_payment',
          tfcDeadline: {
            lt: new Date()
          }
        }
      });

      let cancelledCount = 0;
      for (const booking of expiredBookings) {
        await this.cancelUnpaidTFCBooking(booking.id, 'system', 'Payment deadline exceeded');
        cancelledCount++;
      }

      if (cancelledCount > 0) {
        logger.info(`Auto-cancelled ${cancelledCount} expired TFC bookings`);
      }

      return cancelledCount;
    } catch (error) {
      logger.error('Error processing expired TFC bookings:', error);
      throw error;
    }
  }

  /**
   * Get default TFC instructions
   */
  private getDefaultInstructions(): string {
    return `Please make your Tax-Free Childcare payment using the reference number provided. 

Payment Instructions:
1. Log into your Tax-Free Childcare account
2. Use the reference number shown above
3. Make payment for the exact amount
4. Payment must be received within the deadline to secure your place

If you have any questions, please contact us immediately.`;
  }

  /**
   * Bulk confirm TFC payments
   */
  async bulkConfirmTFCPayments(bookingIds: string[], adminId: string): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const bookingId of bookingIds) {
      try {
        await this.confirmTFCPayment(bookingId, adminId);
        success++;
      } catch (error) {
        logger.error(`Failed to confirm TFC payment for booking ${bookingId}:`, error);
        failed++;
      }
    }

    logger.info(`Bulk TFC confirmation completed`, {
      adminId,
      success,
      failed,
      total: bookingIds.length
    });

    return { success, failed };
  }

  /**
   * Update activity capacity (for internal use)
   * Note: This is a placeholder - in a real system, you might want to track
   * capacity changes more granularly or use a different approach
   */
  private async updateActivityCapacity(activityId: string, change: number): Promise<void> {
    try {
      // For now, we'll just log the capacity change
      // In a real system, you might want to:
      // 1. Update a capacity tracking table
      // 2. Send WebSocket updates to relevant clients
      // 3. Trigger notifications if capacity is now full/available
      
      logger.info(`Activity capacity updated`, {
        activityId,
        change,
        timestamp: new Date().toISOString()
      });

      // TODO: Implement actual capacity tracking if needed
      // This could involve updating a separate capacity table or
      // sending real-time updates to the frontend
    } catch (error) {
      logger.error('Error updating activity capacity:', error);
      // Don't throw here as capacity update failure shouldn't break the main flow
    }
  }
}

export const tfcService = new TFCService();
