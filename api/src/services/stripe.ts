import Stripe from 'stripe';
import { logger } from '../utils/logger';
import { CreatePaymentIntentRequest, RefundRequest } from '../types';

interface StripeConnectAccount {
  id: string;
  business_type: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  country: string;
  email: string;
  default_currency: string;
}

interface CreateConnectAccountRequest {
  email: string;
  country: string;
  business_type: 'individual' | 'company';
  company?: {
    name: string;
    phone?: string;
  };
  individual?: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
  };
  capabilities?: {
    card_payments?: { requested: boolean };
    transfers?: { requested: boolean };
  };
}

class StripeService {
  private stripe: Stripe;
  private platformFeePercentage: number;
  private platformFeeFixed: number;

  constructor() {
    const secretKey = process.env['STRIPE_SECRET_KEY'] || process.env['STRIPE_TEST_SECRET_KEY'];
    if (!secretKey) {
      // In development/non-production, allow server to start without Stripe key (Stripe features will fail gracefully)
      const isProduction = process.env['NODE_ENV'] === 'production';
      if (!isProduction) {
        console.warn('⚠️ STRIPE_SECRET_KEY not set - Stripe features will not work. Set STRIPE_SECRET_KEY in .env for payment functionality.');
        // Don't initialize Stripe client if key is missing - methods will check and throw appropriate errors
        this.stripe = null as any;
      } else {
        throw new Error('STRIPE_SECRET_KEY is required in production');
      }
    } else {
      this.stripe = new Stripe(secretKey, {
        apiVersion: '2023-10-16',
      });
    }

    this.platformFeePercentage = parseFloat(process.env['STRIPE_PLATFORM_FEE_PERCENTAGE'] || '2.9');
    this.platformFeeFixed = parseFloat(process.env['STRIPE_PLATFORM_FEE_FIXED'] || '0.30');
  }

  /**
   * Ensure Stripe client is initialized before use
   */
  private ensureStripeInitialized(): void {
    if (!this.stripe) {
      throw new Error('Stripe is not initialized. Please set STRIPE_SECRET_KEY in your environment variables.');
    }
  }

  /**
   * Create a Stripe Connect account for a venue
   */
  async createConnectAccount(data: CreateConnectAccountRequest): Promise<StripeConnectAccount> {
    this.ensureStripeInitialized();
    try {
      const accountData: Stripe.AccountCreateParams = {
        type: 'express',
        country: data.country,
        email: data.email,
        business_type: data.business_type,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      };

      if (data.business_type === 'company' && data.company) {
        accountData.company = {
          name: data.company.name,
          ...(data.company.phone && { phone: data.company.phone }),
        };
      } else if (data.business_type === 'individual' && data.individual) {
        accountData.individual = {
          first_name: data.individual.first_name,
          last_name: data.individual.last_name,
          email: data.individual.email,
          ...(data.individual.phone && { phone: data.individual.phone }),
        };
      }

      const account = await this.stripe.accounts.create(accountData);
      
      logger.info(`Connect account created: ${account.id} for email: ${data.email}`);
      
      return {
        id: account.id,
        business_type: account.business_type || 'individual',
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        country: account.country || '',
        email: account.email || '',
        default_currency: account.default_currency || 'gbp',
      };
    } catch (error) {
      logger.error('Error creating Connect account:', error);
      throw error;
    }
  }

  /**
   * Get Connect account details
   */
  async getConnectAccount(accountId: string): Promise<StripeConnectAccount> {
    this.ensureStripeInitialized();
    try {
      const account = await this.stripe.accounts.retrieve(accountId);
      
      return {
        id: account.id,
        business_type: account.business_type || 'individual',
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        country: account.country || '',
        email: account.email || '',
        default_currency: account.default_currency || 'gbp',
      };
    } catch (error) {
      logger.error('Error retrieving Connect account:', error);
      throw error;
    }
  }

  /**
   * Create account link for onboarding
   */
  async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<string> {
    this.ensureStripeInitialized();
    try {
      const accountLink = await this.stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });

      logger.info(`Account link created for account: ${accountId}`);
      return accountLink.url;
    } catch (error) {
      logger.error('Error creating account link:', error);
      throw error;
    }
  }

  /**
   * Create a payment intent with Connect (for multi-venue payments)
   */
  async createConnectPaymentIntent(data: CreatePaymentIntentRequest & { connectAccountId: string }): Promise<Stripe.PaymentIntent> {
    this.ensureStripeInitialized();
    try {
      const { bookingId, amount, currency = 'gbp', connectAccountId } = data;

      // Calculate platform fee
      const platformFee = this.calculatePlatformFee(amount);

      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        metadata: {
          bookingId,
          platformFee: platformFee.toString(),
        },
        automatic_payment_methods: {
          enabled: true,
        },
        application_fee_amount: platformFee,
        transfer_data: {
          destination: connectAccountId,
        },
      });

      logger.info(`Connect payment intent created: ${paymentIntent.id} for booking: ${bookingId} to account: ${connectAccountId}`);
      return paymentIntent;
    } catch (error) {
      logger.error('Error creating Connect payment intent:', error);
      throw error;
    }
  }

  /**
   * Create a payment intent for a booking (enhanced with venue support)
   */
  async createPaymentIntent(data: CreatePaymentIntentRequest): Promise<Stripe.PaymentIntent> {
    this.ensureStripeInitialized();
    try {
      const { bookingId, amount, currency = 'gbp', venueId } = data;

      // If venueId is provided, use Connect payment
      if (venueId) {
        // Get venue's Stripe Connect account ID
        const venue = await this.getVenueStripeAccount(venueId);
        if (venue?.stripeAccountId) {
          return this.createConnectPaymentIntent({
            ...data,
            connectAccountId: venue.stripeAccountId,
          });
        }
      }

      // Fallback to platform payment (no venue-specific account)
      const platformFee = this.calculatePlatformFee(amount);

      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        metadata: {
          bookingId,
          platformFee: platformFee.toString(),
        },
        automatic_payment_methods: {
          enabled: true,
        },
        // Note: application_fee_amount is only allowed for Connect payments
        // For platform payments, we'll handle fees separately
      });

      logger.info(`Payment intent created: ${paymentIntent.id} for booking: ${bookingId}`);
      return paymentIntent;
    } catch (error) {
      logger.error('Error creating payment intent:', error);
      throw error;
    }
  }

  /**
   * Get venue's Stripe Connect account
   */
  private async getVenueStripeAccount(venueId: string): Promise<{ stripeAccountId: string | null } | null> {
    try {
      // Import Prisma client
      const { prisma } = await import('../utils/prisma');
      
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { stripeAccountId: true }
      });
      
      return venue || null;
    } catch (error) {
      logger.error('Error getting venue Stripe account:', error);
      return null;
    }
  }

  /**
   * Process a refund with Connect support
   */
  async processRefund(paymentIntentId: string, data: RefundRequest & { connectAccountId?: string }): Promise<Stripe.Refund> {
    try {
      const { amount, reason, connectAccountId } = data;

      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: paymentIntentId,
        metadata: {
          reason: reason || 'No reason provided',
        },
      };
      
      if (reason) {
        refundParams.reason = 'requested_by_customer';
      }

      if (amount) {
        refundParams.amount = Math.round(amount * 100); // Convert to cents
      }

      // If Connect account is provided, use the account-specific API
      if (connectAccountId) {
        const refund = await this.stripe.refunds.create(refundParams, {
          stripeAccount: connectAccountId,
        });
        logger.info(`Connect refund processed: ${refund.id} for payment: ${paymentIntentId} to account: ${connectAccountId}`);
        return refund;
      }

      const refund = await this.stripe.refunds.create(refundParams);
      
      logger.info(`Refund processed: ${refund.id} for payment: ${paymentIntentId}`);
      return refund;
    } catch (error) {
      logger.error('Error processing refund:', error);
      throw error;
    }
  }

  /**
   * Confirm a payment
   */
  async confirmPayment(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      
      if (paymentIntent.status === 'succeeded') {
        logger.info(`Payment already succeeded: ${paymentIntentId}`);
        return paymentIntent;
      }

      if (paymentIntent.status === 'requires_confirmation') {
        const confirmedIntent = await this.stripe.paymentIntents.confirm(paymentIntentId);
        logger.info(`Payment confirmed: ${paymentIntentId}`);
        return confirmedIntent;
      }

      throw new Error(`Payment intent ${paymentIntentId} cannot be confirmed. Status: ${paymentIntent.status}`);
    } catch (error) {
      logger.error('Error confirming payment:', error);
      throw error;
    }
  }

  /**
   * Get payment intent details
   */
  async getPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      logger.error('Error retrieving payment intent:', error);
      throw error;
    }
  }

  /**
   * Get payment method details
   */
  async getPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    try {
      const paymentMethod = await this.stripe.paymentMethods.retrieve(paymentMethodId);
      return paymentMethod;
    } catch (error) {
      logger.error('Error retrieving payment method:', error);
      throw error;
    }
  }

  /**
   * Create a customer
   */
  async createCustomer(email: string, name: string, metadata?: Record<string, string>): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.create({
        email,
        name,
        ...(metadata && { metadata }),
      });

      logger.info(`Customer created: ${customer.id} for email: ${email}`);
      return customer;
    } catch (error) {
      logger.error('Error creating customer:', error);
      throw error;
    }
  }

  /**
   * Update a customer
   */
  async updateCustomer(customerId: string, data: Stripe.CustomerUpdateParams): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.update(customerId, data);
      logger.info(`Customer updated: ${customerId}`);
      return customer;
    } catch (error) {
      logger.error('Error updating customer:', error);
      throw error;
    }
  }

  /**
   * Get customer details
   */
  async getCustomer(customerId: string): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      if (customer.deleted) {
        throw new Error('Customer has been deleted');
      }
      return customer as Stripe.Customer;
    } catch (error) {
      logger.error('Error retrieving customer:', error);
      throw error;
    }
  }

  /**
   * Create a setup intent for saving payment methods
   */
  async createSetupIntent(customerId: string, metadata?: Record<string, string>): Promise<Stripe.SetupIntent> {
    try {
      const setupIntent = await this.stripe.setupIntents.create({
        customer: customerId,
        ...(metadata && { metadata }),
        usage: 'off_session',
      });

      logger.info(`Setup intent created: ${setupIntent.id} for customer: ${customerId}`);
      return setupIntent;
    } catch (error) {
      logger.error('Error creating setup intent:', error);
      throw error;
    }
  }

  /**
   * Create a charge using a saved payment method
   */
  async createCharge(
    customerId: string,
    paymentMethodId: string,
    amount: number,
    currency: string = 'gbp',
    metadata?: Record<string, string>
  ): Promise<Stripe.Charge> {
    try {
      const charge = await this.stripe.charges.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        customer: customerId,
        source: paymentMethodId,
        ...(metadata && { metadata }),
        capture: true,
      });

      logger.info(`Charge created: ${charge.id} for customer: ${customerId}`);
      return charge;
    } catch (error) {
      logger.error('Error creating charge:', error);
      throw error;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<Stripe.Balance> {
    try {
      const balance = await this.stripe.balance.retrieve();
      return balance;
    } catch (error) {
      logger.error('Error retrieving balance:', error);
      throw error;
    }
  }

  /**
   * Get account details
   */
  async getAccount(): Promise<Stripe.Account> {
    try {
      const account = await this.stripe.accounts.retrieve();
      return account;
    } catch (error) {
      logger.error('Error retrieving account:', error);
      throw error;
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string, signature: string, secret: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      logger.error('Webhook signature verification failed:', error);
      throw error;
    }
  }

  /**
   * Calculate platform fee for an amount
   */
  calculatePlatformFee(amount: number): number {
    return Math.round(
      (amount * this.platformFeePercentage / 100 + this.platformFeeFixed) * 100
    );
  }

  /**
   * Get platform fee configuration
   */
  getPlatformFeeConfig(): { percentage: number; fixed: number } {
    return {
      percentage: this.platformFeePercentage,
      fixed: this.platformFeeFixed,
    };
  }

  /**
   * Get Connect account balance
   */
  async getConnectAccountBalance(accountId: string): Promise<Stripe.Balance> {
    try {
      const balance = await this.stripe.balance.retrieve({
        stripeAccount: accountId,
      });
      return balance;
    } catch (error) {
      logger.error('Error retrieving Connect account balance:', error);
      throw error;
    }
  }

  /**
   * Create a transfer to Connect account
   */
  async createTransfer(amount: number, currency: string, destination: string, metadata?: Record<string, string>): Promise<Stripe.Transfer> {
    try {
      const transfer = await this.stripe.transfers.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        destination,
        ...(metadata && { metadata }),
      });

      logger.info(`Transfer created: ${transfer.id} to account: ${destination}`);
      return transfer;
    } catch (error) {
      logger.error('Error creating transfer:', error);
      throw error;
    }
  }

  /**
   * Get transfer details
   */
  async getTransfer(transferId: string): Promise<Stripe.Transfer> {
    try {
      const transfer = await this.stripe.transfers.retrieve(transferId);
      return transfer;
    } catch (error) {
      logger.error('Error retrieving transfer:', error);
      throw error;
    }
  }

  /**
   * List transfers for an account
   */
  async listTransfers(limit: number = 10, startingAfter?: string): Promise<Stripe.ApiList<Stripe.Transfer>> {
    try {
      const transfers = await this.stripe.transfers.list({
        limit,
        ...(startingAfter && { starting_after: startingAfter }),
      });
      return transfers;
    } catch (error) {
      logger.error('Error listing transfers:', error);
      throw error;
    }
  }

  /**
   * Create a refund for a payment
   */
  async createRefund(data: RefundRequest): Promise<Stripe.Refund> {
    try {
      const refundData: Stripe.RefundCreateParams = {
        payment_intent: data.paymentIntentId,
        ...(data.amount && { amount: Math.round(data.amount * 100) }), // Convert to cents
        ...(data.reason && { reason: data.reason as Stripe.RefundCreateParams.Reason }),
        ...(data.connectAccountId && { stripe_account: data.connectAccountId }),
      };

      const refund = await this.stripe.refunds.create(refundData);
      
      logger.info(`Refund created: ${refund.id} for payment: ${data.paymentIntentId}`);
      return refund;
    } catch (error) {
      logger.error('Error creating refund:', error);
      throw error;
    }
  }

  /**
   * List refunds for a payment intent
   */
  async listRefunds(paymentIntentId: string, limit: number = 10): Promise<Stripe.ApiList<Stripe.Refund>> {
    try {
      const refunds = await this.stripe.refunds.list({
        payment_intent: paymentIntentId,
        limit,
      });
      return refunds;
    } catch (error) {
      logger.error('Error listing refunds:', error);
      throw error;
    }
  }
}

// Create and export singleton instance
const stripeService = new StripeService();
export default stripeService;
export { StripeService };
