import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { emailService } from './emailService';

export interface NotificationTemplate {
  id: string;
  type: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  variables: string[];
}

export interface NotificationJob {
  id: string;
  type: string;
  userId: string;
  data: any;
  scheduledFor: Date;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  maxAttempts: number;
}

class NotificationAutomationService {
  private readonly MAX_ATTEMPTS = 3;
  private readonly RETRY_DELAY = 5 * 60 * 1000; // 5 minutes

  /**
   * Send TFC payment instructions email
   */
  async sendTFCPaymentInstructions(
    userId: string,
    bookingData: {
      reference: string;
      deadline: Date;
      amount: number;
      child: string;
      activity: string;
      venue: string;
      instructions: string;
    }
  ): Promise<void> {
    try {
      const user = await safePrismaQuery(async (client) => {
        return await client.user.findUnique({
        where: { id: userId }
        });
      });

      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const subject = `Tax-Free Childcare Payment Instructions - ${bookingData.reference}`;
      
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">Tax-Free Childcare Payment</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Payment Instructions</p>
          </div>
          
          <div style="background: white; padding: 30px; border: 1px solid #e1e5e9; border-top: none;">
            <h2 style="color: #2d3748; margin-top: 0;">Hello ${user.firstName},</h2>
            
            <p>Thank you for choosing Tax-Free Childcare for your booking. Please find below the payment instructions to complete your booking.</p>
            
            <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">Booking Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Child:</td>
                  <td style="padding: 8px 0;">${bookingData.child}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Activity:</td>
                  <td style="padding: 8px 0;">${bookingData.activity}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Venue:</td>
                  <td style="padding: 8px 0;">${bookingData.venue}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Amount:</td>
                  <td style="padding: 8px 0; font-size: 18px; color: #2d3748; font-weight: bold;">£${bookingData.amount.toFixed(2)}</td>
                </tr>
              </table>
            </div>
            
            <div style="background: #e6fffa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #38b2ac;">
              <h3 style="color: #2d3748; margin-top: 0;">Payment Reference</h3>
              <div style="background: white; padding: 15px; border-radius: 6px; text-align: center; font-family: monospace; font-size: 20px; font-weight: bold; color: #2d3748; letter-spacing: 2px;">
                ${bookingData.reference}
              </div>
              <p style="margin: 10px 0 0 0; font-size: 14px; color: #4a5568;">Use this exact reference when making your Tax-Free Childcare payment</p>
            </div>
            
            <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f56565;">
              <h3 style="color: #2d3748; margin-top: 0;">⚠️ Payment Deadline</h3>
              <p style="margin: 0; font-size: 18px; font-weight: bold; color: #e53e3e;">
                ${bookingData.deadline.toLocaleDateString('en-GB', { 
                  weekday: 'long', 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </p>
              <p style="margin: 10px 0 0 0; font-size: 14px; color: #4a5568;">
                Payment must be received by this deadline to secure your place
              </p>
            </div>
            
            <div style="background: #f0fff4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #48bb78;">
              <h3 style="color: #2d3748; margin-top: 0;">How to Pay</h3>
              <ol style="margin: 0; padding-left: 20px;">
                <li style="margin-bottom: 8px;">Log into your Tax-Free Childcare account at <a href="https://www.gov.uk/help-with-childcare-costs/tax-free-childcare" style="color: #3182ce;">gov.uk</a></li>
                <li style="margin-bottom: 8px;">Use the payment reference: <strong>${bookingData.reference}</strong></li>
                <li style="margin-bottom: 8px;">Make payment for the exact amount: <strong>£${bookingData.amount.toFixed(2)}</strong></li>
                <li style="margin-bottom: 8px;">Payment must be received by the deadline to secure your place</li>
              </ol>
            </div>
            
            ${bookingData.instructions ? `
              <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #2d3748; margin-top: 0;">Additional Instructions</h3>
                <p style="white-space: pre-line; margin: 0;">${bookingData.instructions}</p>
              </div>
            ` : ''}
            
            <div style="background: #edf2f7; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">Important Notes</h3>
              <ul style="margin: 0; padding-left: 20px;">
                <li style="margin-bottom: 8px;">Your booking is reserved but not confirmed until payment is received</li>
                <li style="margin-bottom: 8px;">If payment is not received by the deadline, your booking will be automatically cancelled</li>
                <li style="margin-bottom: 8px;">You will receive email confirmation once payment is processed</li>
                <li style="margin-bottom: 8px;">Contact us immediately if you have any issues with your payment</li>
              </ul>
            </div>
            
            <p>If you have any questions or need assistance, please don't hesitate to contact us.</p>
            
            <p style="margin-top: 30px;">
              Best regards,<br>
              The BookOn Team
            </p>
          </div>
          
          <div style="background: #2d3748; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; font-size: 14px;">
            <p style="margin: 0;">© 2024 BookOn. All rights reserved.</p>
            <p style="margin: 5px 0 0 0; opacity: 0.8;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </body>
        </html>
      `;

      const textContent = `
        Tax-Free Childcare Payment Instructions - ${bookingData.reference}
        
        Hello ${user.firstName},
        
        Thank you for choosing Tax-Free Childcare for your booking. Please find below the payment instructions to complete your booking.
        
        BOOKING DETAILS:
        Child: ${bookingData.child}
        Activity: ${bookingData.activity}
        Venue: ${bookingData.venue}
        Amount: £${bookingData.amount.toFixed(2)}
        
        PAYMENT REFERENCE: ${bookingData.reference}
        Use this exact reference when making your Tax-Free Childcare payment.
        
        PAYMENT DEADLINE: ${bookingData.deadline.toLocaleDateString('en-GB', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })}
        
        HOW TO PAY:
        1. Log into your Tax-Free Childcare account at gov.uk
        2. Use the payment reference: ${bookingData.reference}
        3. Make payment for the exact amount: £${bookingData.amount.toFixed(2)}
        4. Payment must be received by the deadline to secure your place
        
        ${bookingData.instructions ? `ADDITIONAL INSTRUCTIONS:\n${bookingData.instructions}\n` : ''}
        
        IMPORTANT NOTES:
        - Your booking is reserved but not confirmed until payment is received
        - If payment is not received by the deadline, your booking will be automatically cancelled
        - You will receive email confirmation once payment is processed
        - Contact us immediately if you have any issues with your payment
        
        If you have any questions or need assistance, please don't hesitate to contact us.
        
        Best regards,
        The BookOn Team
      `;

      // Send email
      await emailService.sendEmail({
        to: user.email,
        toName: user.firstName,
        subject,
        htmlContent,
        textContent
      });

      // Create notification record
      await prisma.notification.create({
        data: {
          userId,
          type: 'tfc_payment_instructions',
          title: 'TFC Payment Instructions',
          message: `Payment instructions sent for booking ${bookingData.reference}`,
          channels: ['email'],
          status: 'sent',
          sentAt: new Date(),
          data: {
            bookingData,
            emailSent: true
          }
        }
      });

      logger.info('TFC payment instructions sent', {
        userId,
        reference: bookingData.reference,
        amount: bookingData.amount
      });
    } catch (error) {
      logger.error('Error sending TFC payment instructions:', error);
      throw error;
    }
  }

  /**
   * Send TFC payment reminder email
   */
  async sendTFCPaymentReminder(
    userId: string,
    bookingData: {
      reference: string;
      deadline: Date;
      amount: number;
      child: string;
      activity: string;
      venue: string;
      daysRemaining: number;
    }
  ): Promise<void> {
    try {
      const user = await safePrismaQuery(async (client) => {
        return await client.user.findUnique({
        where: { id: userId }
        });
      });

      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const subject = `Reminder: Tax-Free Childcare Payment Due Soon - ${bookingData.reference}`;
      
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">Payment Reminder</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Tax-Free Childcare Payment Due Soon</p>
          </div>
          
          <div style="background: white; padding: 30px; border: 1px solid #e1e5e9; border-top: none;">
            <h2 style="color: #2d3748; margin-top: 0;">Hello ${user.firstName},</h2>
            
            <p>This is a friendly reminder that your Tax-Free Childcare payment is due soon for the following booking:</p>
            
            <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">Booking Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Child:</td>
                  <td style="padding: 8px 0;">${bookingData.child}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Activity:</td>
                  <td style="padding: 8px 0;">${bookingData.activity}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Venue:</td>
                  <td style="padding: 8px 0;">${bookingData.venue}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Amount:</td>
                  <td style="padding: 8px 0; font-size: 18px; color: #2d3748; font-weight: bold;">£${bookingData.amount.toFixed(2)}</td>
                </tr>
              </table>
            </div>
            
            <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f56565;">
              <h3 style="color: #2d3748; margin-top: 0;">⏰ Payment Deadline</h3>
              <p style="margin: 0; font-size: 18px; font-weight: bold; color: #e53e3e;">
                ${bookingData.deadline.toLocaleDateString('en-GB', { 
                  weekday: 'long', 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </p>
              <p style="margin: 10px 0 0 0; font-size: 16px; color: #e53e3e; font-weight: bold;">
                Only ${bookingData.daysRemaining} day${bookingData.daysRemaining !== 1 ? 's' : ''} remaining!
              </p>
            </div>
            
            <div style="background: #e6fffa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #38b2ac;">
              <h3 style="color: #2d3748; margin-top: 0;">Payment Reference</h3>
              <div style="background: white; padding: 15px; border-radius: 6px; text-align: center; font-family: monospace; font-size: 20px; font-weight: bold; color: #2d3748; letter-spacing: 2px;">
                ${bookingData.reference}
              </div>
            </div>
            
            <div style="background: #f0fff4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #48bb78;">
              <h3 style="color: #2d3748; margin-top: 0;">Quick Payment Steps</h3>
              <ol style="margin: 0; padding-left: 20px;">
                <li style="margin-bottom: 8px;">Log into your Tax-Free Childcare account</li>
                <li style="margin-bottom: 8px;">Use reference: <strong>${bookingData.reference}</strong></li>
                <li style="margin-bottom: 8px;">Pay exactly: <strong>£${bookingData.amount.toFixed(2)}</strong></li>
                <li style="margin-bottom: 8px;">Complete payment before the deadline</li>
              </ol>
            </div>
            
            <div style="background: #edf2f7; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">⚠️ Important</h3>
              <p style="margin: 0; color: #e53e3e; font-weight: bold;">
                If payment is not received by the deadline, your booking will be automatically cancelled and the space will be released to other families.
              </p>
            </div>
            
            <p>Please make your payment as soon as possible to secure your place.</p>
            
            <p style="margin-top: 30px;">
              Best regards,<br>
              The BookOn Team
            </p>
          </div>
          
          <div style="background: #2d3748; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; font-size: 14px;">
            <p style="margin: 0;">© 2024 BookOn. All rights reserved.</p>
            <p style="margin: 5px 0 0 0; opacity: 0.8;">This is an automated reminder. Please do not reply to this email.</p>
          </div>
        </body>
        </html>
      `;

      // Send email
      await emailService.sendEmail({
        to: user.email,
        toName: user.firstName,
        subject,
        htmlContent,
        textContent: `Payment reminder for booking ${bookingData.reference}. Only ${bookingData.daysRemaining} days remaining.`
      });

      // Create notification record
      await prisma.notification.create({
        data: {
          userId,
          type: 'tfc_payment_reminder',
          title: 'TFC Payment Reminder',
          message: `Payment reminder sent for booking ${bookingData.reference}`,
          channels: ['email'],
          status: 'sent',
          sentAt: new Date(),
          data: {
            bookingData,
            emailSent: true
          }
        }
      });

      logger.info('TFC payment reminder sent', {
        userId,
        reference: bookingData.reference,
        daysRemaining: bookingData.daysRemaining
      });
    } catch (error) {
      logger.error('Error sending TFC payment reminder:', error);
      throw error;
    }
  }

  /**
   * Send cancellation confirmation email
   */
  async sendCancellationConfirmation(
    userId: string,
    cancellationData: {
      bookingId: string;
      child: string;
      activity: string;
      venue: string;
      refundAmount: number;
      creditAmount: number;
      adminFee: number;
      method: 'cash' | 'credit' | 'mixed';
      reason: string;
    }
  ): Promise<void> {
    try {
      const user = await safePrismaQuery(async (client) => {
        return await client.user.findUnique({
        where: { id: userId }
        });
      });

      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const subject = `Booking Cancellation Confirmed - ${cancellationData.activity}`;
      
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">Booking Cancelled</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Cancellation Confirmed</p>
          </div>
          
          <div style="background: white; padding: 30px; border: 1px solid #e1e5e9; border-top: none;">
            <h2 style="color: #2d3748; margin-top: 0;">Hello ${user.firstName},</h2>
            
            <p>Your booking cancellation has been processed successfully. Here are the details:</p>
            
            <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">Cancelled Booking</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Child:</td>
                  <td style="padding: 8px 0;">${cancellationData.child}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Activity:</td>
                  <td style="padding: 8px 0;">${cancellationData.activity}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Venue:</td>
                  <td style="padding: 8px 0;">${cancellationData.venue}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Reason:</td>
                  <td style="padding: 8px 0;">${cancellationData.reason}</td>
                </tr>
              </table>
            </div>
            
            ${cancellationData.refundAmount > 0 ? `
              <div style="background: #f0fff4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #48bb78;">
                <h3 style="color: #2d3748; margin-top: 0;">💰 Cash Refund</h3>
                <p style="margin: 0; font-size: 24px; font-weight: bold; color: #2d3748;">
                  £${cancellationData.refundAmount.toFixed(2)}
                </p>
                <p style="margin: 10px 0 0 0; font-size: 14px; color: #4a5568;">
                  This amount will be refunded to your original payment method within 3-5 business days.
                </p>
              </div>
            ` : ''}
            
            ${cancellationData.creditAmount > 0 ? `
              <div style="background: #e6fffa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #38b2ac;">
                <h3 style="color: #2d3748; margin-top: 0;">💳 Wallet Credit</h3>
                <p style="margin: 0; font-size: 24px; font-weight: bold; color: #2d3748;">
                  £${cancellationData.creditAmount.toFixed(2)}
                </p>
                <p style="margin: 10px 0 0 0; font-size: 14px; color: #4a5568;">
                  This credit has been added to your wallet and can be used for future bookings. Credits expire after 12 months.
                </p>
              </div>
            ` : ''}
            
            ${cancellationData.adminFee > 0 ? `
              <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f56565;">
                <h3 style="color: #2d3748; margin-top: 0;">📋 Admin Fee</h3>
                <p style="margin: 0; font-size: 18px; font-weight: bold; color: #e53e3e;">
                  -£${cancellationData.adminFee.toFixed(2)}
                </p>
                <p style="margin: 10px 0 0 0; font-size: 14px; color: #4a5568;">
                  A £2.00 admin fee applies to all cancellations made by parents.
                </p>
              </div>
            ` : ''}
            
            <div style="background: #edf2f7; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">What's Next?</h3>
              <ul style="margin: 0; padding-left: 20px;">
                ${cancellationData.refundAmount > 0 ? '<li style="margin-bottom: 8px;">Your cash refund will be processed within 3-5 business days</li>' : ''}
                ${cancellationData.creditAmount > 0 ? '<li style="margin-bottom: 8px;">Your wallet credit is now available for future bookings</li>' : ''}
                <li style="margin-bottom: 8px;">You can view your wallet balance and credit history in your account</li>
                <li style="margin-bottom: 8px;">Feel free to book other activities using your credits</li>
              </ul>
            </div>
            
            <p>If you have any questions about this cancellation or need assistance with future bookings, please don't hesitate to contact us.</p>
            
            <p style="margin-top: 30px;">
              Best regards,<br>
              The BookOn Team
            </p>
          </div>
          
          <div style="background: #2d3748; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; font-size: 14px;">
            <p style="margin: 0;">© 2024 BookOn. All rights reserved.</p>
            <p style="margin: 5px 0 0 0; opacity: 0.8;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </body>
        </html>
      `;

      // Send email
      await emailService.sendEmail({
        to: user.email,
        toName: user.firstName,
        subject,
        htmlContent,
        textContent: `Booking cancellation confirmed for ${cancellationData.activity}. ${cancellationData.refundAmount > 0 ? `Refund: £${cancellationData.refundAmount.toFixed(2)}` : ''} ${cancellationData.creditAmount > 0 ? `Credit: £${cancellationData.creditAmount.toFixed(2)}` : ''}`
      });

      // Create notification record
      await prisma.notification.create({
        data: {
          userId,
          type: 'cancellation_confirmation',
          title: 'Booking Cancelled',
          message: `Cancellation confirmed for ${cancellationData.activity}`,
          channels: ['email'],
          status: 'sent',
          sentAt: new Date(),
          data: {
            cancellationData,
            emailSent: true
          }
        }
      });

      logger.info('Cancellation confirmation sent', {
        userId,
        bookingId: cancellationData.bookingId,
        refundAmount: cancellationData.refundAmount,
        creditAmount: cancellationData.creditAmount
      });
    } catch (error) {
      logger.error('Error sending cancellation confirmation:', error);
      throw error;
    }
  }

  /**
   * Process scheduled notifications
   */
  async processScheduledNotifications(): Promise<number> {
    try {
      const now = new Date();
      
      // Get pending notifications that are due
      const pendingNotifications = await safePrismaQuery(async (client) => {
        return await client.notification.findMany({
        where: {
          status: 'pending',
          createdAt: {
            lte: now
          }
        },
        take: 50 // Process in batches
        });
      });

      let processedCount = 0;

      for (const notification of pendingNotifications) {
        try {
          // Update status to processing
          await safePrismaQuery(async (client) => {
            return await client.notification.update({
              where: { id: notification.id },
              data: { status: 'sent', sentAt: new Date() }
            });
          });

          processedCount++;
        } catch (error) {
          logger.error(`Error processing notification ${notification.id}:`, error);
          
          // Mark as failed
          await safePrismaQuery(async (client) => {
            return await client.notification.update({
              where: { id: notification.id },
              data: { 
                status: 'failed', 
                error: error instanceof Error ? error.message : 'Unknown error'
              }
            });
          });
        }
      }

      if (processedCount > 0) {
        logger.info(`Processed ${processedCount} scheduled notifications`);
      }

      return processedCount;
    } catch (error) {
      logger.error('Error processing scheduled notifications:', error);
      throw error;
    }
  }

  /**
   * Send credit expiry reminder
   */
  async sendCreditExpiryReminder(
    userId: string,
    creditData: {
      creditId: string;
      amount: number;
      expiryDate: Date;
      daysUntilExpiry: number;
    }
  ): Promise<void> {
    try {
      const user = await safePrismaQuery(async (client) => {
        return await client.user.findUnique({
        where: { id: userId }
        });
      });

      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const subject = `Credit Expiring Soon - £${creditData.amount.toFixed(2)}`;
      
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #f6ad55 0%, #ed8936 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">Credit Expiring Soon</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Don't Let Your Credit Go to Waste</p>
          </div>
          
          <div style="background: white; padding: 30px; border: 1px solid #e1e5e9; border-top: none;">
            <h2 style="color: #2d3748; margin-top: 0;">Hello ${user.firstName},</h2>
            
            <p>We wanted to remind you that you have a credit in your wallet that will expire soon.</p>
            
            <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f56565;">
              <h3 style="color: #2d3748; margin-top: 0;">⏰ Credit Expiring</h3>
              <p style="margin: 0; font-size: 24px; font-weight: bold; color: #e53e3e;">
                £${creditData.amount.toFixed(2)}
              </p>
              <p style="margin: 10px 0 0 0; font-size: 16px; color: #e53e3e; font-weight: bold;">
                Expires in ${creditData.daysUntilExpiry} day${creditData.daysUntilExpiry !== 1 ? 's' : ''}
              </p>
              <p style="margin: 10px 0 0 0; font-size: 14px; color: #4a5568;">
                Expiry Date: ${creditData.expiryDate.toLocaleDateString('en-GB', { 
                  weekday: 'long', 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric'
                })}
              </p>
            </div>
            
            <div style="background: #f0fff4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #48bb78;">
              <h3 style="color: #2d3748; margin-top: 0;">💡 Use Your Credit</h3>
              <p style="margin: 0 0 15px 0;">Don't let your credit go to waste! You can use it to:</p>
              <ul style="margin: 0; padding-left: 20px;">
                <li style="margin-bottom: 8px;">Book new activities for your children</li>
                <li style="margin-bottom: 8px;">Pay for additional sessions</li>
                <li style="margin-bottom: 8px;">Cover part of a larger booking</li>
                <li style="margin-bottom: 8px;">Transfer to other family members</li>
              </ul>
            </div>
            
            <div style="background: #e6fffa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #38b2ac;">
              <h3 style="color: #2d3748; margin-top: 0;">🚀 Quick Action</h3>
              <p style="margin: 0 0 15px 0;">Ready to use your credit? Here's how:</p>
              <ol style="margin: 0; padding-left: 20px;">
                <li style="margin-bottom: 8px;">Browse available activities</li>
                <li style="margin-bottom: 8px;">Select your preferred booking</li>
                <li style="margin-bottom: 8px;">Choose to use your wallet credit at checkout</li>
                <li style="margin-bottom: 8px;">Complete your booking</li>
              </ol>
            </div>
            
            <div style="background: #edf2f7; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #2d3748; margin-top: 0;">⚠️ Important</h3>
              <p style="margin: 0; color: #e53e3e; font-weight: bold;">
                Credits cannot be extended or refunded once they expire. Please use your credit before the expiry date to avoid losing it.
              </p>
            </div>
            
            <p>If you have any questions about your credit or need help booking, please don't hesitate to contact us.</p>
            
            <p style="margin-top: 30px;">
              Best regards,<br>
              The BookOn Team
            </p>
          </div>
          
          <div style="background: #2d3748; color: white; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; font-size: 14px;">
            <p style="margin: 0;">© 2024 BookOn. All rights reserved.</p>
            <p style="margin: 5px 0 0 0; opacity: 0.8;">This is an automated reminder. Please do not reply to this email.</p>
          </div>
        </body>
        </html>
      `;

      // Send email
      await emailService.sendEmail({
        to: user.email,
        toName: user.firstName,
        subject,
        htmlContent,
        textContent: `Credit expiring soon: £${creditData.amount.toFixed(2)} expires in ${creditData.daysUntilExpiry} days`
      });

      // Create notification record
      await prisma.notification.create({
        data: {
          userId,
          type: 'credit_expiry_reminder',
          title: 'Credit Expiring Soon',
          message: `Credit of £${creditData.amount.toFixed(2)} expires in ${creditData.daysUntilExpiry} days`,
          channels: ['email'],
          status: 'sent',
          sentAt: new Date(),
          data: {
            creditData,
            emailSent: true
          }
        }
      });

      logger.info('Credit expiry reminder sent', {
        userId,
        creditId: creditData.creditId,
        amount: creditData.amount,
        daysUntilExpiry: creditData.daysUntilExpiry
      });
    } catch (error) {
      logger.error('Error sending credit expiry reminder:', error);
      throw error;
    }
  }
}

export const notificationAutomationService = new NotificationAutomationService();
