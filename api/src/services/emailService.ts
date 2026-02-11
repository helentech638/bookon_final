import sgMail from '@sendgrid/mail';
import { logger } from '../utils/logger';

interface EmailData {
  to: string;
  toName: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  templateId?: string;
  placeholders?: Record<string, string>;
  trackingEnabled?: boolean;
}

interface EmailEvent {
  emailId: string;
  eventType: string;
  timestamp: string;
  metadata?: any;
}

class EmailService {
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;
  private webhookSecret: string;

  constructor() {
    this.apiKey = process.env.SENDGRID_API_KEY || '';
    this.fromEmail = process.env.FROM_EMAIL || 'noreply@bookon.com';
    this.fromName = process.env.FROM_NAME || 'BookOn';
    this.webhookSecret = process.env.SENDGRID_WEBHOOK_SECRET || '';

    if (this.apiKey) {
      sgMail.setApiKey(this.apiKey);
    }
  }

  async sendEmail(emailData: EmailData): Promise<string | null> {
    try {
      if (!this.apiKey) {
        logger.warn('SendGrid API key not configured, skipping email send');
        return null;
      }

      const msg = {
        to: emailData.to,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: emailData.subject,
        html: emailData.htmlContent,
        text: emailData.textContent,
        trackingSettings: {
          clickTracking: {
            enable: emailData.trackingEnabled !== false
          },
          openTracking: {
            enable: emailData.trackingEnabled !== false
          }
        },
        customArgs: {
          emailId: emailData.templateId || 'unknown'
        }
      };

      const response = await sgMail.send(msg);
      const messageId = response[0]?.headers?.['x-message-id'] as string;
      
      logger.info('Email sent successfully', {
        to: emailData.to,
        subject: emailData.subject,
        messageId
      });

      return messageId;
    } catch (error) {
      logger.error('Failed to send email:', error);
      throw error;
    }
  }

  async sendTemplateEmail(
    templateId: string,
    to: string,
    toName: string,
    placeholders: Record<string, string> = {}
  ): Promise<string | null> {
    try {
      if (!this.apiKey) {
        logger.warn('SendGrid API key not configured, skipping template email send');
        return null;
      }

      const msg = {
        to: to,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        templateId: templateId,
        dynamicTemplateData: {
          to_name: toName,
          ...placeholders
        },
        trackingSettings: {
          clickTracking: { enable: true },
          openTracking: { enable: true }
        },
        customArgs: {
          templateId,
          emailId: `template_${templateId}_${Date.now()}`
        }
      };

      const response = await sgMail.send(msg);
      const messageId = response[0]?.headers?.['x-message-id'] as string;
      
      logger.info('Template email sent successfully', {
        to,
        templateId,
        messageId
      });

      return messageId;
    } catch (error) {
      logger.error('Failed to send template email:', error);
      throw error;
    }
  }

  async sendBulkEmails(emails: EmailData[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    // SendGrid allows up to 1000 emails per request
    const batchSize = 1000;
    const batches = [];

    for (let i = 0; i < emails.length; i += batchSize) {
      batches.push(emails.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      try {
        const messages = batch.map(emailData => ({
          to: emailData.to,
          from: {
            email: this.fromEmail,
            name: this.fromName
          },
          subject: emailData.subject,
          html: emailData.htmlContent,
          text: emailData.textContent,
          trackingSettings: {
            clickTracking: { enable: emailData.trackingEnabled !== false },
            openTracking: { enable: emailData.trackingEnabled !== false }
          },
          customArgs: {
            emailId: emailData.templateId || 'unknown'
          }
        }));

        await sgMail.send(messages);
        success += batch.length;
        
        logger.info(`Batch of ${batch.length} emails sent successfully`);
      } catch (error) {
        logger.error(`Failed to send batch of ${batch.length} emails:`, error);
        failed += batch.length;
      }
    }

    return { success, failed };
  }

  processWebhookEvent(event: any): EmailEvent | null {
    try {
      // Verify webhook signature if secret is configured
      if (this.webhookSecret) {
        // Add signature verification logic here
        // This is a simplified version - implement proper HMAC verification
      }

      const eventType = event.event;
      const emailId = event.sg_message_id;
      const timestamp = event.timestamp;

      if (!emailId || !eventType) {
        logger.warn('Invalid webhook event received:', event);
        return null;
      }

      const emailEvent: EmailEvent = {
        emailId,
        eventType: this.mapEventType(eventType),
        timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
        metadata: {
          userAgent: event.useragent,
          ip: event.ip,
          url: event.url,
          reason: event.reason,
          response: event.response,
          attempt: event.attempt,
          category: event.category,
          sgEventId: event.sg_event_id,
          sgMessageId: event.sg_message_id
        }
      };

      logger.info('Email event processed', {
        emailId,
        eventType: emailEvent.eventType,
        timestamp: emailEvent.timestamp
      });

      return emailEvent;
    } catch (error) {
      logger.error('Failed to process webhook event:', error);
      return null;
    }
  }

  private mapEventType(sendGridEventType: string): string {
    const eventTypeMap: Record<string, string> = {
      'processed': 'sent',
      'delivered': 'delivered',
      'open': 'opened',
      'click': 'clicked',
      'bounce': 'bounced',
      'dropped': 'dropped',
      'spam_report': 'spam_report',
      'unsubscribe': 'unsubscribed',
      'group_unsubscribe': 'unsubscribed',
      'group_resubscribe': 'resubscribed'
    };

    return eventTypeMap[sendGridEventType] || sendGridEventType;
  }

  async validateEmail(email: string): Promise<boolean> {
    try {
      if (!this.apiKey) {
        return true; // Skip validation if no API key
      }

      // Use SendGrid's email validation API
      const response = await fetch('https://api.sendgrid.com/v3/validations/email', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email
        })
      });

      if (response.ok) {
        const data = await response.json() as { result?: { valid?: boolean } };
        return data.result?.valid === true;
      }

      return true; // Default to valid if validation fails
    } catch (error) {
      logger.error('Email validation failed:', error);
      return true; // Default to valid if validation fails
    }
  }

  async getEmailStats(startDate: string, endDate: string): Promise<any> {
    try {
      if (!this.apiKey) {
        return null;
      }

      const response = await fetch(
        `https://api.sendgrid.com/v3/stats?start_date=${startDate}&end_date=${endDate}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`
          }
        }
      );

      if (response.ok) {
        return await response.json();
      }

      return null;
    } catch (error) {
      logger.error('Failed to fetch email stats:', error);
      return null;
    }
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Send TFC instructions email
   */
  async sendTFCInstructions(data: {
    to: string;
    parentName: string;
    childName: string;
    activityName: string;
    venueName: string;
    paymentReference: string;
    deadline: Date;
    amount: number;
    tfcConfig: any;
  }): Promise<void> {
    try {
      const subject = `Tax-Free Childcare Payment Required - ${data.activityName}`;
      
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Tax-Free Childcare Payment Required</h2>
          
          <p>Dear ${data.parentName},</p>
          
          <p>Thank you for booking <strong>${data.activityName}</strong> for ${data.childName}.</p>
          
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #1f2937; margin-top: 0;">Payment Details</h3>
            <p><strong>Payment Reference:</strong> <code style="background-color: #e5e7eb; padding: 4px 8px; border-radius: 4px;">${data.paymentReference}</code></p>
            <p><strong>Amount Due:</strong> £${data.amount.toFixed(2)}</p>
            <p><strong>Payment Deadline:</strong> ${data.deadline.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
          </div>
          
          <h3>How to Pay:</h3>
          <ol>
            <li>Log into your <strong>Tax-Free Childcare account</strong> at <a href="https://www.gov.uk/apply-tax-free-childcare">gov.uk/apply-tax-free-childcare</a></li>
            <li>Make a payment to <strong>${data.tfcConfig.providerName}</strong> using the reference above</li>
            <li>Your booking will be confirmed automatically once payment is received</li>
          </ol>
          
          <div style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #92400e;"><strong>Important:</strong> Please complete payment by the deadline to secure your place. If payment is not received, your booking will be automatically cancelled.</p>
          </div>
          
          <p>If you have any questions, please contact us at support@bookon.com or call 01234 567890.</p>
          
          <p>Best regards,<br>The BookOn Team</p>
        </div>
      `;

      await this.sendEmail({
        to: data.to,
        toName: data.parentName,
        subject,
        htmlContent: html
      });

      logger.info('TFC instructions email sent', { to: data.to, paymentReference: data.paymentReference });
    } catch (error) {
      logger.error('Failed to send TFC instructions email:', error);
      throw error;
    }
  }

  /**
   * Send TFC cancellation email
   */
  async sendTFCCancellation(data: {
    to: string;
    parentName: string;
    childName: string;
    activityName: string;
    paymentReference: string;
  }): Promise<void> {
    try {
      const subject = `Booking Cancelled - Payment Deadline Expired - ${data.activityName}`;
      
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc2626;">Booking Cancelled</h2>
          
          <p>Dear ${data.parentName},</p>
          
          <p>Unfortunately, your booking for <strong>${data.activityName}</strong> for ${data.childName} has been cancelled as the payment deadline has expired.</p>
          
          <div style="background-color: #fef2f2; border: 1px solid #fca5a5; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #991b1b;"><strong>Payment Reference:</strong> ${data.paymentReference}</p>
            <p style="margin: 5px 0 0 0; color: #991b1b;">This booking is no longer reserved for you.</p>
          </div>
          
          <p>If you would like to book this activity again, please visit our website and complete the payment process within the specified timeframe.</p>
          
          <p>If you have any questions, please contact us at support@bookon.com or call 01234 567890.</p>
          
          <p>Best regards,<br>The BookOn Team</p>
        </div>
      `;

      await this.sendEmail({
        to: data.to,
        toName: data.parentName,
        subject,
        htmlContent: html
      });

      logger.info('TFC cancellation email sent', { to: data.to, paymentReference: data.paymentReference });
    } catch (error) {
      logger.error('Failed to send TFC cancellation email:', error);
      throw error;
    }
  }

  /**
   * Send credit issued email
   */
  async sendCreditIssued(data: {
    to: string;
    parentName: string;
    amount: number;
    reason: string;
    expiryDate: Date;
  }): Promise<void> {
    try {
      const subject = `Credit Issued - £${data.amount.toFixed(2)}`;
      
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #059669;">Credit Issued</h2>
          
          <p>Dear ${data.parentName},</p>
          
          <p>We have issued a credit to your BookOn account.</p>
          
          <div style="background-color: #f0fdf4; border: 1px solid #86efac; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #166534; margin-top: 0;">Credit Details</h3>
            <p><strong>Amount:</strong> £${data.amount.toFixed(2)}</p>
            <p><strong>Reason:</strong> ${data.reason}</p>
            <p><strong>Expires:</strong> ${data.expiryDate.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          </div>
          
          <p>This credit can be used towards future bookings. Simply select "Use Credit" at checkout to apply it to your next booking.</p>
          
          <p>If you have any questions, please contact us at support@bookon.com or call 01234 567890.</p>
          
          <p>Best regards,<br>The BookOn Team</p>
        </div>
      `;

      await this.sendEmail({
        to: data.to,
        toName: data.parentName,
        subject,
        htmlContent: html
      });

      logger.info('Credit issued email sent', { to: data.to, amount: data.amount });
    } catch (error) {
      logger.error('Failed to send credit issued email:', error);
      throw error;
    }
  }
}

export const emailService = new EmailService();
export default emailService;