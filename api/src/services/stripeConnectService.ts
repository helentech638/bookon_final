import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const prisma = new PrismaClient();

export interface CreateAccountParams {
  email: string;
  country: string;
  businessType: 'individual' | 'company';
  companyName?: string;
  firstName?: string;
  lastName?: string;
}

export interface UpdateAccountParams {
  businessAccountId: string;
  franchiseFeeType: 'percent' | 'fixed';
  franchiseFeeValue: number;
  vatMode: 'inclusive' | 'exclusive';
  adminFeeAmount?: number;
}

export class StripeConnectService {
  /**
   * Create a new Stripe Connect Express account
   */
  static async createExpressAccount(params: CreateAccountParams): Promise<Stripe.Account> {
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        country: params.country,
        email: params.email,
        business_type: params.businessType,
        business_profile: {
          name: params.companyName || `${params.firstName} ${params.lastName}`,
          url: undefined, // Can be added later
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      return account;
    } catch (error) {
      console.error('Error creating Stripe Express account:', error);
      throw new Error('Failed to create Stripe Connect account');
    }
  }

  /**
   * Create account link for onboarding
   */
  static async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<Stripe.AccountLink> {
    try {
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });

      return accountLink;
    } catch (error) {
      console.error('Error creating account link:', error);
      throw new Error('Failed to create account onboarding link');
    }
  }

  /**
   * Get account details
   */
  static async getAccount(accountId: string): Promise<Stripe.Account> {
    try {
      const account = await stripe.accounts.retrieve(accountId);
      return account;
    } catch (error) {
      console.error('Error retrieving Stripe account:', error);
      throw new Error('Failed to retrieve Stripe account');
    }
  }

  /**
   * Check account status
   */
  static async getAccountStatus(accountId: string): Promise<{
    status: 'onboarded' | 'action_required' | 'rejected';
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirements: any;
  }> {
    try {
      const account = await stripe.accounts.retrieve(accountId);
      
      return {
        status: account.details_submitted && account.charges_enabled && account.payouts_enabled 
          ? 'onboarded' 
          : account.details_submitted 
            ? 'action_required' 
            : 'rejected',
        detailsSubmitted: account.details_submitted,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        requirements: account.requirements,
      };
    } catch (error) {
      console.error('Error checking account status:', error);
      throw new Error('Failed to check account status');
    }
  }

  /**
   * Create payment intent with destination charges
   */
  static async createPaymentIntent(params: {
    amount: number;
    currency: string;
    customerId?: string;
    connectedAccountId: string;
    applicationFeeAmount: number;
    metadata?: Record<string, string>;
  }): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: params.amount,
        currency: params.currency,
        customer: params.customerId,
        application_fee_amount: params.applicationFeeAmount,
        transfer_data: {
          destination: params.connectedAccountId,
        },
        metadata: params.metadata || {},
      }, {
        stripeAccount: params.connectedAccountId,
      });

      return paymentIntent;
    } catch (error) {
      console.error('Error creating payment intent:', error);
      throw new Error('Failed to create payment intent');
    }
  }

  /**
   * Process refund with proportional fee reversal
   */
  static async processRefund(params: {
    paymentIntentId: string;
    amount?: number;
    refundApplicationFee?: boolean;
    reason?: string;
  }): Promise<Stripe.Refund> {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: params.paymentIntentId,
        amount: params.amount,
        refund_application_fee: params.refundApplicationFee ?? true,
        reason: params.reason as any,
      });

      return refund;
    } catch (error) {
      console.error('Error processing refund:', error);
      throw new Error('Failed to process refund');
    }
  }

  /**
   * Calculate franchise fee
   */
  static calculateFranchiseFee(
    amount: number,
    feeType: 'percent' | 'fixed',
    feeValue: number,
    vatMode: 'inclusive' | 'exclusive' = 'inclusive'
  ): {
    grossAmount: number;
    franchiseFee: number;
    vatAmount: number;
    netAmount: number;
  } {
    let franchiseFee = 0;
    
    if (feeType === 'percent') {
      franchiseFee = Math.round((amount * feeValue) / 100);
    } else {
      franchiseFee = feeValue;
    }

    // Calculate VAT (20% UK rate)
    const vatRate = 0.20;
    let vatAmount = 0;
    let netAmount = 0;

    if (vatMode === 'inclusive') {
      // VAT is included in the franchise fee
      vatAmount = Math.round(franchiseFee * vatRate / (1 + vatRate));
      netAmount = franchiseFee - vatAmount;
    } else {
      // VAT is added on top of the franchise fee
      vatAmount = Math.round(franchiseFee * vatRate);
      netAmount = franchiseFee;
    }

    return {
      grossAmount: amount,
      franchiseFee: franchiseFee,
      vatAmount: vatAmount,
      netAmount: netAmount,
    };
  }

  /**
   * Get business account with Stripe status
   */
  static async getBusinessAccountWithStatus(businessAccountId: string) {
    try {
      const businessAccount = await prisma.businessAccount.findUnique({
        where: { id: businessAccountId },
        include: {
          venues: {
            select: {
              id: true,
              name: true,
              inheritFranchiseFee: true,
              franchiseFeeType: true,
              franchiseFeeValue: true,
            },
          },
        },
      });

      if (!businessAccount) {
        throw new Error('Business account not found');
      }

      // Get Stripe account status
      const stripeStatus = await this.getAccountStatus(businessAccount.stripeAccountId);

      return {
        ...businessAccount,
        stripeStatus,
      };
    } catch (error) {
      console.error('Error getting business account with status:', error);
      throw new Error('Failed to get business account status');
    }
  }
}

export default StripeConnectService;
