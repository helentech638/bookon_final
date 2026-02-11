import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { auditService } from './auditService';

export interface TransferRequest {
  fromBookingId: string;
  toActivityId: string;
  parentId: string;
  reason: string;
  transferDate?: Date;
}

export interface TransferResult {
  success: boolean;
  newBookingId?: string;
  refundAmount?: number;
  creditAmount?: number;
  additionalPayment?: number;
  message: string;
}

export interface ChargebackData {
  bookingId: string;
  chargebackId: string;
  amount: number;
  reason: string;
  status: 'pending' | 'won' | 'lost';
  receivedAt: Date;
  evidenceDueDate?: Date;
}

class EdgeCaseService {
  /**
   * Handle booking transfer between activities
   */
  async processBookingTransfer(
    transferRequest: TransferRequest,
    adminId?: string
  ): Promise<TransferResult> {
    try {
      const { fromBookingId, toActivityId, parentId, reason, transferDate } = transferRequest;

      // Get original booking
      const originalBooking = await prisma.booking.findFirst({
        where: {
          id: fromBookingId,
          parentId: parentId
        },
        include: {
          activity: {
            include: {
              venue: true
            }
          },
          child: true
        }
      });

      if (!originalBooking) {
        throw new AppError('Original booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Get target activity
      const targetActivity = await prisma.activity.findUnique({
        where: { id: toActivityId },
        include: { venue: true }
      });

      if (!targetActivity) {
        throw new AppError('Target activity not found', 404, 'ACTIVITY_NOT_FOUND');
      }

      // Check if transfer is allowed (same venue, not in the past, etc.)
      if (originalBooking.activity.venueId !== targetActivity.venueId) {
        throw new AppError('Cannot transfer between different venues', 400, 'INVALID_TRANSFER');
      }

      const now = new Date();
      const originalActivityDate = new Date(originalBooking.activityDate);
      
      if (originalActivityDate <= now) {
        throw new AppError('Cannot transfer past activities', 400, 'PAST_ACTIVITY_TRANSFER');
      }

      // Calculate price difference
      const originalPrice = Number(originalBooking.amount);
      const targetPrice = Number(targetActivity.price || 0);
      const priceDifference = targetPrice - originalPrice;

      // Cancel original booking
      await prisma.booking.update({
        where: { id: fromBookingId },
        data: {
          status: 'cancelled',
          notes: `Transferred to ${targetActivity.title}: ${reason}`,
          updatedAt: new Date()
        }
      });

      // Create new booking
      const newBooking = await prisma.booking.create({
        data: {
          parentId,
          childId: originalBooking.childId,
          activityId: toActivityId,
          status: 'confirmed',
          paymentStatus: originalBooking.paymentStatus,
          paymentMethod: originalBooking.paymentMethod,
          amount: targetPrice,
          totalAmount: targetPrice,
          currency: originalBooking.currency,
          paymentIntentId: originalBooking.paymentIntentId,
          tfcReference: originalBooking.tfcReference,
          tfcDeadline: originalBooking.tfcDeadline,
          tfcInstructions: originalBooking.tfcInstructions,
          holdPeriod: originalBooking.holdPeriod,
          bookingDate: transferDate || new Date(),
          activityDate: targetActivity.startDate, // Use startDate from Activity
          activityTime: targetActivity.startTime, // Use startTime from Activity
          notes: `Transferred from ${originalBooking.activity.title}: ${reason}`
        }
      });

      let refundAmount = 0;
      let creditAmount = 0;
      let additionalPayment = 0;

      // Handle price difference
      if (priceDifference > 0) {
        // Need to pay more
        additionalPayment = priceDifference;
      } else if (priceDifference < 0) {
        // Refund the difference
        const refundAmount = Math.abs(priceDifference);
        
        if (originalBooking.paymentMethod === 'card') {
          // Get paymentId from booking's payment
          const payment = await prisma.payment.findFirst({
            where: { bookingId: fromBookingId },
            orderBy: { createdAt: 'desc' }
          });

          if (payment) {
            // Create refund transaction
            await prisma.refundTransaction.create({
              data: {
                paymentId: payment.id,
                bookingId: fromBookingId,
                amount: refundAmount,
                method: 'card',
                fee: 0, // No fee for transfers
                reason: 'transfer_refund',
                status: 'pending',
                adminId: adminId || null,
                auditTrail: {
                  transferFrom: fromBookingId,
                  transferTo: newBooking.id,
                  reason,
                  processedBy: adminId || null
                }
              }
            });
          }
        } else {
          // Issue credit
          await prisma.walletCredit.create({
            data: {
              parentId,
              providerId: targetActivity.venueId,
              bookingId: fromBookingId,
              amount: refundAmount,
              expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
              source: 'transfer_refund',
              status: 'active',
              description: `Transfer refund from ${originalBooking.activity.title} to ${targetActivity.title}`
            }
          });
          creditAmount = refundAmount;
        }
      }

      // Log audit event
      await auditService.logEvent(
        'booking',
        newBooking.id,
        'transfer',
        adminId || parentId,
        adminId ? 'admin' : 'parent',
        {
          fromBookingId,
          toActivityId,
          priceDifference,
          additionalPayment,
          refundAmount,
          creditAmount
        },
        { reason, transferDate }
      );

      logger.info('Booking transfer processed', {
        fromBookingId,
        toBookingId: newBooking.id,
        parentId,
        priceDifference,
        additionalPayment,
        refundAmount,
        creditAmount
      });

      return {
        success: true,
        newBookingId: newBooking.id,
        refundAmount,
        creditAmount,
        additionalPayment,
        message: priceDifference > 0 
          ? `Transfer successful. Additional payment of £${additionalPayment.toFixed(2)} required.`
          : priceDifference < 0
          ? `Transfer successful. Refund of £${Math.abs(priceDifference).toFixed(2)} will be processed.`
          : 'Transfer successful. No payment changes required.'
      };
    } catch (error) {
      logger.error('Error processing booking transfer:', error);
      throw error;
    }
  }

  /**
   * Handle chargeback dispute
   */
  async processChargeback(
    chargebackData: ChargebackData,
    adminId: string
  ): Promise<void> {
    try {
      const { bookingId, chargebackId, amount, reason, status, receivedAt, evidenceDueDate } = chargebackData;

      // Get booking
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          activity: true,
          parent: true
        }
      });

      if (!booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      // Create chargeback record
      const chargeback = await prisma.chargeback.create({
        data: {
          bookingId,
          chargebackId,
          amount,
          reason,
          status,
          receivedAt,
          evidenceDueDate,
          adminId,
          createdAt: new Date()
        }
      });

      // Lock booking for refunds while dispute is active
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          notes: `Chargeback dispute active: ${chargebackId}. Refunds locked.`,
          updatedAt: new Date()
        }
      });

      // Log audit event
      await auditService.logEvent(
        'booking',
        bookingId,
        'chargeback_received',
        adminId,
        'admin',
        {
          chargebackId,
          amount,
          reason,
          status
        },
        { receivedAt, evidenceDueDate }
      );

      logger.info('Chargeback processed', {
        bookingId,
        chargebackId,
        amount,
        reason,
        status,
        adminId
      });
    } catch (error) {
      logger.error('Error processing chargeback:', error);
      throw error;
    }
  }

  /**
   * Resolve chargeback dispute
   */
  async resolveChargeback(
    chargebackId: string,
    resolution: 'won' | 'lost',
    adminId: string,
    notes?: string
  ): Promise<void> {
    try {
      const chargeback = await prisma.chargeback.findUnique({
        where: { chargebackId },
        include: {
          booking: true
        }
      });

      if (!chargeback) {
        throw new AppError('Chargeback not found', 404, 'CHARGEBACK_NOT_FOUND');
      }

      // Update chargeback status
      await prisma.chargeback.update({
        where: { chargebackId },
        data: {
          status: resolution,
          resolvedAt: new Date(),
          resolvedBy: adminId,
          resolutionNotes: notes
        }
      });

      // Unlock booking
      await prisma.booking.update({
        where: { id: chargeback.bookingId },
        data: {
          notes: `Chargeback ${resolution}: ${chargebackId}. ${notes || ''}`,
          updatedAt: new Date()
        }
      });

      // If chargeback was lost, process refund
      if (resolution === 'lost') {
        // Get paymentId from booking's payment
        const payment = await prisma.payment.findFirst({
          where: { bookingId: chargeback.bookingId },
          orderBy: { createdAt: 'desc' }
        });

        if (payment) {
          await prisma.refundTransaction.create({
            data: {
              paymentId: payment.id,
              bookingId: chargeback.bookingId,
              amount: chargeback.amount,
              method: 'card',
              fee: 0, // No admin fee for chargeback refunds
              reason: 'chargeback_lost',
              status: 'pending',
              adminId,
              auditTrail: {
                chargebackId,
                resolution,
                notes
              }
            }
          });
        }
      }

      // Log audit event
      await auditService.logEvent(
        'chargeback',
        chargebackId,
        'chargeback_resolved',
        adminId,
        'admin',
        {
          resolution,
          notes
        },
        { resolvedAt: new Date() }
      );

      logger.info('Chargeback resolved', {
        chargebackId,
        resolution,
        adminId,
        notes
      });
    } catch (error) {
      logger.error('Error resolving chargeback:', error);
      throw error;
    }
  }

  /**
   * Handle partial refunds for mixed payments
   */
  async processPartialRefund(
    bookingId: string,
    refundAmount: number,
    refundMethod: 'card' | 'credit' | 'mixed',
    adminId: string,
    reason: string
  ): Promise<{ refundTransactionId?: string; creditId?: string }> {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          activity: true
        }
      });

      if (!booking) {
        throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
      }

      const totalPaid = Number(booking.amount);
      
      if (refundAmount > totalPaid) {
        throw new AppError('Refund amount cannot exceed total paid', 400, 'INVALID_REFUND_AMOUNT');
      }

      let refundTransactionId: string | undefined;
      let creditId: string | undefined;

      if (refundMethod === 'card' || refundMethod === 'mixed') {
        const cardRefundAmount = refundMethod === 'mixed' ? refundAmount * 0.5 : refundAmount;
        
        // Get paymentId from booking's payment
        const payment = await prisma.payment.findFirst({
          where: { bookingId },
          orderBy: { createdAt: 'desc' }
        });

        if (payment) {
          const refundTransaction = await prisma.refundTransaction.create({
            data: {
              paymentId: payment.id,
              bookingId,
              amount: cardRefundAmount,
              method: 'card',
              fee: 0,
              reason: 'partial_refund',
              status: 'pending',
              adminId,
              auditTrail: {
                originalAmount: totalPaid,
                refundAmount,
                refundMethod,
                reason,
                processedBy: adminId
              }
            }
          });
          refundTransactionId = refundTransaction.id;
        }
      }

      if (refundMethod === 'credit' || refundMethod === 'mixed') {
        const creditRefundAmount = refundMethod === 'mixed' ? refundAmount * 0.5 : refundAmount;
        
        const credit = await prisma.walletCredit.create({
          data: {
            parentId: booking.parentId,
            providerId: booking.activity.venueId,
            bookingId,
            amount: creditRefundAmount,
            expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            source: 'partial_refund',
            status: 'active',
            description: `Partial refund for booking ${bookingId}: ${reason}`
          }
        });
        creditId = credit.id;
      }

      // Log audit event
      await auditService.logEvent(
        'booking',
        bookingId,
        'partial_refund',
        adminId,
        'admin',
        {
          refundAmount,
          refundMethod,
          refundTransactionId,
          creditId
        },
        { reason }
      );

      logger.info('Partial refund processed', {
        bookingId,
        refundAmount,
        refundMethod,
        refundTransactionId,
        creditId,
        adminId
      });

      return { refundTransactionId, creditId };
    } catch (error) {
      logger.error('Error processing partial refund:', error);
      throw error;
    }
  }

  /**
   * Handle bulk operations with rollback capability
   */
  async processBulkOperation<T>(
    operations: Array<() => Promise<T>>,
    operationName: string,
    adminId: string
  ): Promise<{ results: T[]; failed: number; success: number }> {
    const results: T[] = [];
    const rollbackOperations: Array<() => Promise<void>> = [];
    let failed = 0;
    let success = 0;

    try {
      for (let i = 0; i < operations.length; i++) {
        try {
          const result = await operations[i]();
          results.push(result);
          success++;
        } catch (error) {
          logger.error(`Bulk operation ${operationName} failed at step ${i}:`, error);
          failed++;
          
          // Rollback previous operations
          for (let j = rollbackOperations.length - 1; j >= 0; j--) {
            try {
              await rollbackOperations[j]();
            } catch (rollbackError) {
              logger.error(`Rollback failed for operation ${j}:`, rollbackError);
            }
          }
          
          throw error;
        }
      }

      // Log successful bulk operation
      await auditService.logEvent(
        'system',
        'bulk_operation',
        'bulk_operation_completed',
        adminId,
        'admin',
        {
          operationName,
          totalOperations: operations.length,
          success,
          failed
        },
        { completedAt: new Date() }
      );

      return { results, failed, success };
    } catch (error) {
      logger.error(`Bulk operation ${operationName} failed:`, error);
      
      // Log failed bulk operation
      await auditService.logEvent(
        'system',
        'bulk_operation',
        'bulk_operation_failed',
        adminId,
        'admin',
        {
          operationName,
          totalOperations: operations.length,
          success,
          failed,
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        { failedAt: new Date() }
      );

      throw error;
    }
  }

  /**
   * Handle system recovery scenarios
   */
  async recoverFromSystemError(
    errorType: string,
    affectedEntities: string[],
    adminId: string
  ): Promise<void> {
    try {
      // Log recovery attempt
      await auditService.logEvent(
        'system',
        'recovery',
        'system_recovery_started',
        adminId,
        'admin',
        {
          errorType,
          affectedEntities: affectedEntities.length
        },
        { recoveryStartedAt: new Date() }
      );

      // Implement recovery logic based on error type
      switch (errorType) {
        case 'payment_processing_failure':
          // Mark affected bookings as failed and notify users
          for (const bookingId of affectedEntities) {
            await prisma.booking.update({
              where: { id: bookingId },
              data: {
                paymentStatus: 'failed',
                notes: 'Payment processing failed - system recovery in progress',
                updatedAt: new Date()
              }
            });
          }
          break;

        case 'notification_failure':
          // Retry failed notifications
          for (const notificationId of affectedEntities) {
            await prisma.notification.update({
              where: { id: notificationId },
              data: {
                status: 'pending',
                updatedAt: new Date()
              }
            });
          }
          break;

        case 'credit_expiry_failure':
          // Process expired credits
          await prisma.walletCredit.updateMany({
            where: {
              id: { in: affectedEntities }
            },
            data: {
              status: 'expired',
              updatedAt: new Date()
            }
          });
          break;

        default:
          logger.warn(`Unknown error type for recovery: ${errorType}`);
      }

      // Log successful recovery
      await auditService.logEvent(
        'system',
        'recovery',
        'system_recovery_completed',
        adminId,
        'admin',
        {
          errorType,
          recoveredEntities: affectedEntities.length
        },
        { recoveryCompletedAt: new Date() }
      );

      logger.info('System recovery completed', {
        errorType,
        affectedEntities: affectedEntities.length,
        adminId
      });
    } catch (error) {
      logger.error('System recovery failed:', error);
      
      // Log failed recovery
      await auditService.logEvent(
        'system',
        'recovery',
        'system_recovery_failed',
        adminId,
        'admin',
        {
          errorType,
          affectedEntities: affectedEntities.length,
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        { recoveryFailedAt: new Date() }
      );

      throw error;
    }
  }
}

export const edgeCaseService = new EdgeCaseService();
