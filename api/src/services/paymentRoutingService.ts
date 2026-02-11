import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import StripeConnectService from './stripeConnectService';
import FranchiseFeeService from './franchiseFeeService';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const prisma = new PrismaClient();

export interface PaymentIntentParams {
  amount: number;
  currency: string;
  customerId?: string;
  venueId: string;
  bookingId: string;
  metadata?: Record<string, string>;
}

export interface RefundParams {
  paymentIntentId: string;
  amount?: number;
  reason?: string;
  adminFeeExcluded?: boolean;
}

export class PaymentRoutingService {
  /**
   * Create payment intent with franchise fee routing
   */
  static async createPaymentIntent(params: PaymentIntentParams): Promise<{
    paymentIntent: Stripe.PaymentIntent;
    franchiseFeeBreakdown: any;
    applicationFeeAmount: number;
  }> {
    try {
      // Get venue and business account
      const venue = await prisma.venue.findUnique({
        where: { id: params.venueId },
        include: {
          businessAccount: true,
        },
      });

      if (!venue || !venue.businessAccount) {
        throw new Error('Venue or business account not found');
      }

      // Calculate franchise fee
      const franchiseFeeCalculation = await FranchiseFeeService.calculateEffectiveFranchiseFee(
        params.venueId,
        params.amount
      );

      const applicationFeeAmount = Math.round(franchiseFeeCalculation.calculatedFee);

      // Create payment intent with destination charges
      const paymentIntent = await StripeConnectService.createPaymentIntent({
        amount: params.amount,
        currency: params.currency,
        customerId: params.customerId,
        connectedAccountId: venue.businessAccount.stripeAccountId,
        applicationFeeAmount: applicationFeeAmount,
        metadata: {
          ...params.metadata,
          venueId: params.venueId,
          bookingId: params.bookingId,
          businessAccountId: venue.businessAccount.id,
          franchiseFeeType: franchiseFeeCalculation.franchiseFeeType,
          franchiseFeeValue: franchiseFeeCalculation.franchiseFeeValue.toString(),
        },
      });

      return {
        paymentIntent,
        franchiseFeeBreakdown: franchiseFeeCalculation.breakdown,
        applicationFeeAmount,
      };
    } catch (error) {
      console.error('Error creating payment intent:', error);
      throw new Error('Failed to create payment intent');
    }
  }

  /**
   * Process refund with proportional franchise fee reversal
   */
  static async processRefund(params: RefundParams): Promise<{
    refund: Stripe.Refund;
    franchiseFeeReversal: number;
  }> {
    try {
      // Get the original payment intent to calculate proportional fee reversal
      const paymentIntent = await stripe.paymentIntents.retrieve(params.paymentIntentId);
      
      if (!paymentIntent.metadata?.venueId) {
        throw new Error('Payment intent metadata missing venue information');
      }

      const venueId = paymentIntent.metadata.venueId;
      const originalAmount = paymentIntent.amount;
      const refundAmount = params.amount || originalAmount;

      // Calculate proportional franchise fee reversal
      const franchiseFeeCalculation = await FranchiseFeeService.calculateEffectiveFranchiseFee(
        venueId,
        originalAmount
      );

      const proportionalFranchiseFee = Math.round(
        (franchiseFeeCalculation.calculatedFee * refundAmount) / originalAmount
      );

      // Process refund with proportional fee reversal
      const refund = await StripeConnectService.processRefund({
        paymentIntentId: params.paymentIntentId,
        amount: refundAmount,
        refundApplicationFee: true, // Always reverse franchise fee proportionally
        reason: params.reason,
      });

      return {
        refund,
        franchiseFeeReversal: proportionalFranchiseFee,
      };
    } catch (error) {
      console.error('Error processing refund:', error);
      throw new Error('Failed to process refund');
    }
  }

  /**
   * Get payment breakdown for a transaction
   */
  static async getPaymentBreakdown(paymentIntentId: string): Promise<{
    grossAmount: number;
    franchiseFee: number;
    vatAmount: number;
    adminFee: number;
    stripeFee: number;
    netToVenue: number;
    businessAccountName: string;
    venueName: string;
  }> {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      
      if (!paymentIntent.metadata?.venueId) {
        throw new Error('Payment intent metadata missing venue information');
      }

      const venue = await prisma.venue.findUnique({
        where: { id: paymentIntent.metadata.venueId },
        include: {
          businessAccount: true,
        },
      });

      if (!venue || !venue.businessAccount) {
        throw new Error('Venue or business account not found');
      }

      // Calculate franchise fee breakdown
      const franchiseFeeCalculation = await FranchiseFeeService.calculateEffectiveFranchiseFee(
        venue.id,
        paymentIntent.amount
      );

      // Get Stripe fees (this would typically come from webhook events)
      // For now, we'll estimate based on Stripe's pricing
      const stripeFeeRate = 0.014 + 0.20; // 1.4% + 20p per transaction
      const stripeFee = Math.round(paymentIntent.amount * stripeFeeRate);

      const netToVenue = paymentIntent.amount - franchiseFeeCalculation.calculatedFee - stripeFee;

      return {
        grossAmount: paymentIntent.amount,
        franchiseFee: franchiseFeeCalculation.calculatedFee,
        vatAmount: franchiseFeeCalculation.breakdown.vatAmount,
        adminFee: franchiseFeeCalculation.breakdown.adminFee,
        stripeFee: stripeFee,
        netToVenue: netToVenue,
        businessAccountName: venue.businessAccount.name,
        venueName: venue.name,
      };
    } catch (error) {
      console.error('Error getting payment breakdown:', error);
      throw new Error('Failed to get payment breakdown');
    }
  }

  /**
   * Create Stripe Connect account for a business
   */
  static async createBusinessAccount(params: {
    email: string;
    country: string;
    businessType: 'individual' | 'company';
    companyName?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{
    account: Stripe.Account;
    accountLink: Stripe.AccountLink;
  }> {
    try {
      // Create Stripe Express account
      const account = await StripeConnectService.createExpressAccount(params);

      // Create account link for onboarding
      const accountLink = await StripeConnectService.createAccountLink(
        account.id,
        `${process.env.FRONTEND_URL}/admin/business-accounts/${account.id}/onboarding/refresh`,
        `${process.env.FRONTEND_URL}/admin/business-accounts/${account.id}/onboarding/success`
      );

      return {
        account,
        accountLink,
      };
    } catch (error) {
      console.error('Error creating business account:', error);
      throw new Error('Failed to create business account');
    }
  }

  /**
   * Update business account Stripe status
   */
  static async updateBusinessAccountStatus(businessAccountId: string): Promise<{
    status: 'onboarded' | 'action_required' | 'rejected';
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  }> {
    try {
      const businessAccount = await prisma.businessAccount.findUnique({
        where: { id: businessAccountId },
      });

      if (!businessAccount) {
        throw new Error('Business account not found');
      }

      const stripeStatus = await StripeConnectService.getAccountStatus(businessAccount.stripeAccountId);

      // Update database with current status
      await prisma.businessAccount.update({
        where: { id: businessAccountId },
        data: {
          status: stripeStatus.status,
          updatedAt: new Date(),
        },
      });

      return stripeStatus;
    } catch (error) {
      console.error('Error updating business account status:', error);
      throw new Error('Failed to update business account status');
    }
  }

  /**
   * Get all business accounts with Stripe status
   */
  static async getAllBusinessAccountsWithStatus(): Promise<any[]> {
    try {
      const businessAccounts = await prisma.businessAccount.findMany({
        include: {
          venues: {
            select: {
              id: true,
              name: true,
              address: true,
              city: true,
              inheritFranchiseFee: true,
              franchiseFeeType: true,
              franchiseFeeValue: true,
            },
          },
          _count: {
            select: {
              venues: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Get Stripe status for each account
      const accountsWithStatus = await Promise.all(
        businessAccounts.map(async (account) => {
          try {
            const stripeStatus = await StripeConnectService.getAccountStatus(account.stripeAccountId);
            return {
              ...account,
              stripeStatus,
            };
          } catch (error) {
            console.error(`Error getting status for account ${account.id}:`, error);
            return {
              ...account,
              stripeStatus: {
                status: 'rejected',
                detailsSubmitted: false,
                chargesEnabled: false,
                payoutsEnabled: false,
                requirements: null,
              },
            };
          }
        })
      );

      return accountsWithStatus;
    } catch (error) {
      console.error('Error getting business accounts with status:', error);
      throw new Error('Failed to get business accounts with status');
    }
  }
}

export default PaymentRoutingService;
