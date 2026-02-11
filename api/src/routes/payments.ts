import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { body, validationResult } from 'express-validator';
import stripeService from '../services/stripe';
import Stripe from 'stripe';

const router = Router();

// Validation middleware
const validatePaymentIntent = [
  body('bookingId').isUUID().withMessage('Booking ID must be a valid UUID'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('currency').optional().isIn(['gbp', 'usd', 'eur']).withMessage('Invalid currency'),
  body('venueId').optional().isUUID().withMessage('Venue ID must be a valid UUID'),
];

// Create payment intent for a booking
router.post('/create-intent', authenticateToken, validatePaymentIntent, asyncHandler(async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.error('Payment intent validation failed:', {
        errors: errors.array(),
        body: req.body,
        userId: req.user?.id
      });
      throw new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { bookingId, amount, currency = 'gbp', venueId } = req.body;
    const userId = req.user!.id;

    // Get booking details
    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        parentId: userId,
        // Note: isActive field doesn't exist in current schema
      },
      include: {
        activity: {
          select: {
            title: true,
            startDate: true,
            startTime: true,
            venue: {
              select: {
                name: true,
                stripeAccountId: true
              }
            }
          }
        }
      }
    });

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    if (booking.status !== 'pending') {
      throw new AppError('Booking is not in pending status', 400, 'BOOKING_NOT_PENDING');
    }

    // Check if payment already exists
    const existingPayment = await prisma.payment.findFirst({
      where: {
        bookingId: bookingId,
        isActive: true
      }
    });

    if (existingPayment) {
      throw new AppError('Payment already exists for this booking', 400, 'PAYMENT_ALREADY_EXISTS');
    }

    // Create Stripe payment intent with Connect support
    const paymentIntent = await stripeService.createPaymentIntent({
      bookingId,
      amount,
      currency,
      venueId: venueId || booking.activity.venue?.stripeAccountId,
    });

    // Create payment record in database
    const payment = await prisma.payment.create({
      data: {
        bookingId: bookingId,
        userId: userId,
        stripePaymentIntentId: paymentIntent.id,
        amount: amount,
        currency: currency,
        status: 'pending',
        paymentMethod: 'stripe',
        stripeAccountId: venueId || booking.activity.venue?.stripeAccountId,
        isActive: true
      }
    });

    logger.info('Payment intent created successfully', { 
      paymentId: payment.id, 
      bookingId,
      userId,
      stripeIntentId: paymentIntent.id,
      venueId: venueId || booking.activity.venue?.stripeAccountId
    });

    res.json({
      success: true,
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: amount,
        currency: currency,
        booking: {
          id: booking.id,
          activityTitle: booking.activity.title,
          venueName: booking.activity.venue?.name,
          startDate: booking.activity.startDate,
          startTime: booking.activity.startTime,
        }
      }
    });
  } catch (error) {
    logger.error('Error creating payment intent:', error);
    throw error;
  }
}));

// Confirm payment intent
router.post('/confirm', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    // const userId = req.user!.id; // Unused variable
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      throw new AppError('Payment intent ID is required', 400, 'MISSING_PAYMENT_INTENT_ID');
    }

    // Get payment details
    const payment = await prisma.payment.findFirst({
      where: {
        stripePaymentIntentId: paymentIntentId,
        isActive: true
      }
    });

    if (!payment) {
      throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    }

    // Confirm payment intent with Stripe
    const paymentIntent = await stripeService.confirmPayment(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      // Update payment status
      await prisma.payment.update({
        where: { stripePaymentIntentId: paymentIntentId },
        data: {
          status: 'completed',
          updatedAt: new Date(),
        }
      });

      // Update booking status
      await prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          status: 'confirmed',
          updatedAt: new Date(),
        }
      });

      logger.info('Payment confirmed successfully', { paymentIntentId, bookingId: payment.bookingId });

      res.json({
        success: true,
        message: 'Payment confirmed successfully',
        data: {
          paymentIntentId,
          status: paymentIntent.status,
        },
      });
    } else {
      throw new AppError('Payment confirmation failed', 400, 'PAYMENT_CONFIRMATION_FAILED');
    }
  } catch (error) {
    logger.error('Error confirming payment:', error);
    if (error instanceof AppError) throw error;
    
    if (error instanceof Stripe.errors.StripeError) {
      throw new AppError(`Payment error: ${error.message}`, 400, 'STRIPE_ERROR');
    }
    
    throw new AppError('Failed to confirm payment', 500, 'PAYMENT_CONFIRMATION_ERROR');
  }
}));

// Get payment status
router.get('/:id/status', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    
    const payment = await prisma.payment.findFirst({
      where: {
        id: id,
        userId: userId,
        isActive: true
      },
      include: {
        booking: {
          include: {
            activity: {
              select: {
                title: true
              }
            }
          }
        }
      }
    });

    if (!payment) {
      throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    }

    // Get latest status from Stripe if payment intent exists
    let stripeStatus = null;
    if (payment.stripePaymentIntentId) {
      try {
        const paymentIntent = await stripeService.getPaymentIntent(payment.stripePaymentIntentId);
        stripeStatus = paymentIntent.status;
      } catch (stripeError) {
        logger.warn('Could not retrieve Stripe payment intent', { 
          paymentId: id, 
          stripeError 
        });
      }
    }

    res.json({
      success: true,
      data: {
        id: payment.id,
        status: payment.status,
        stripeStatus,
        amount: parseFloat(payment.amount.toString()),
        currency: payment.currency,
        bookingStatus: payment.booking.status,
        activityTitle: payment.booking.activity.title,
        createdAt: payment.createdAt,
        completedAt: payment.completedAt
      }
    });
  } catch (error) {
    logger.error('Error fetching payment status:', error);
    throw new AppError('Failed to fetch payment status', 500, 'PAYMENT_STATUS_ERROR');
  }
}));

// Get all payments for user
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { 
      page = '1', 
      limit = '10', 
      status 
    } = req.query;
    
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    const whereClause: any = {
      userId: userId,
      isActive: true
    };

    // Filter by status
    if (status && status !== 'all') {
      whereClause.status = status;
    }

    const payments = await prisma.payment.findMany({
      where: whereClause,
      include: {
        booking: {
          include: {
            activity: {
              select: {
                title: true,
                startDate: true,
                startTime: true
              }
            }
          }
        }
      },
      skip: offset,
      take: parseInt(limit as string),
      orderBy: { createdAt: 'desc' }
    });

    // Get total count for pagination
    const totalCount = await prisma.payment.count({
      where: whereClause
    });

    res.json({
      success: true,
      data: payments.map(payment => ({
        id: payment.id,
        status: payment.status,
        amount: parseFloat(payment.amount.toString()),
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        booking: {
          status: payment.booking.status,
          activity: {
            title: payment.booking.activity.title,
            startDate: payment.booking.activity.startDate,
            startTime: payment.booking.activity.startTime
          }
        },
        createdAt: payment.createdAt,
        completedAt: payment.completedAt
      })),
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: totalCount,
        pages: Math.ceil(totalCount / parseInt(limit as string))
      }
    });
  } catch (error) {
    logger.error('Error fetching payments:', error);
    throw new AppError('Failed to fetch payments', 500, 'PAYMENTS_FETCH_ERROR');
  }
}));

// Refund payment
router.post('/:id/refund', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { reason } = req.body;
    
    // Get payment record
    const payment = await prisma.payment.findFirst({
      where: {
        id: id,
        userId: userId,
        isActive: true
      },
      include: {
        booking: true
      }
    });

    if (!payment) {
      throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    }

    if (payment.status !== 'completed') {
      throw new AppError('Only completed payments can be refunded', 400, 'PAYMENT_NOT_REFUNDABLE');
    }

    // Check if booking is within refund window (e.g., 7 days)
    const booking = payment.booking;

    if (booking) {
      const now = new Date();
      const paymentDate = new Date(payment.completedAt!);
      const daysSincePayment = (now.getTime() - paymentDate.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSincePayment > 7) {
        throw new AppError('Refund window has expired (7 days)', 400, 'REFUND_WINDOW_EXPIRED');
      }
    }

    // Process refund through Stripe
    let refund;
    if (payment.stripePaymentIntentId) {
      try {
        refund = await stripeService.processRefund(payment.stripePaymentIntentId, {
          paymentIntentId: payment.stripePaymentIntentId,
          reason: reason || 'Customer requested refund',
        });
      } catch (stripeError) {
        logger.error('Error processing Stripe refund:', stripeError);
        throw new AppError('Failed to process refund with Stripe', 500, 'STRIPE_REFUND_ERROR');
      }
    }

    // Update payment status
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        updatedAt: new Date(),
      }
    });

    // Update booking status
    await prisma.booking.update({
      where: { id: payment.bookingId },
      data: {
        status: 'cancelled',
        updatedAt: new Date(),
      }
    });

    logger.info('Payment refunded successfully', { 
      paymentId: payment.id, 
      bookingId: payment.bookingId,
      userId,
      refundId: refund?.id
    });

    res.json({
      success: true,
      message: 'Payment refunded successfully',
      data: {
        paymentId: payment.id,
        status: 'refunded',
        refundId: refund?.id
      }
    });
  } catch (error) {
    logger.error('Error refunding payment:', error);
    if (error instanceof AppError) throw error;
    throw new AppError('Failed to refund payment', 500, 'PAYMENT_REFUND_ERROR');
  }
}));

// Webhook endpoint for Stripe events
router.post('/webhook', asyncHandler(async (req: Request, res: Response) => {
  try {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env['STRIPE_WEBHOOK_SECRET'];

    if (!sig || !endpointSecret) {
      throw new AppError('Missing webhook signature or secret', 400, 'WEBHOOK_SIGNATURE_MISSING');
    }

    let event: Stripe.Event;

    try {
      event = stripeService.verifyWebhookSignature(req.body, sig as string, endpointSecret);
    } catch (err) {
      logger.error('Webhook signature verification failed', { err });
      return res.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object as Stripe.PaymentIntent);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object as Stripe.PaymentIntent);
        break;
      case 'refund.created':
        await handleRefundCreated(event.data.object as Stripe.Refund);
        break;
      default:
        logger.info(`Unhandled event type: ${event.type}`);
    }

    return res.json({ received: true });
  } catch (error) {
    logger.error('Webhook error:', error);
    return res.status(400).send(`Webhook Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}));

// Helper functions for webhook handling
async function handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
  try {
    const payment = await prisma.payment.findFirst({
      where: {
        stripePaymentIntentId: paymentIntent.id,
        isActive: true
      }
    });

    if (payment) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        }
      });

      await prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          status: 'confirmed',
          updatedAt: new Date(),
        }
      });

      logger.info('Payment completed via webhook', { 
        paymentId: payment.id, 
        bookingId: payment.bookingId 
      });
    }
  } catch (error) {
    logger.error('Error handling payment success webhook:', error);
  }
}

async function handlePaymentFailure(paymentIntent: Stripe.PaymentIntent) {
  try {
    const payment = await prisma.payment.findFirst({
      where: {
        stripePaymentIntentId: paymentIntent.id,
        isActive: true
      }
    });

    if (payment) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          updatedAt: new Date(),
        }
      });

      logger.info('Payment failed via webhook', { 
        paymentId: payment.id, 
        bookingId: payment.bookingId 
      });
    }
  } catch (error) {
    logger.error('Error handling payment failure webhook:', error);
  }
}

async function handleRefundCreated(refund: Stripe.Refund) {
  try {
    const payment = await prisma.payment.findFirst({
      where: {
        stripePaymentIntentId: refund.payment_intent as string,
        isActive: true
      }
    });

    if (payment) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'refunded',
          refundedAt: new Date(),
          updatedAt: new Date(),
        }
      });

      await prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          status: 'cancelled',
          updatedAt: new Date(),
        }
      });

      logger.info('Payment refunded via webhook', { 
        paymentId: payment.id, 
        bookingId: payment.bookingId,
        refundId: refund.id
      });
    }
  } catch (error) {
    logger.error('Error handling refund created webhook:', error);
  }
}

// Process refund for a payment
router.post('/refund', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { paymentId, amount, reason } = req.body;
    
    if (!paymentId) {
      throw new AppError('Payment ID is required', 400, 'PAYMENT_ID_REQUIRED');
    }

    // Get payment details
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        isActive: true
      },
      include: {
        booking: {
          include: {
            activity: {
              include: {
                venue: {
                  select: {
                    stripeAccountId: true
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!payment) {
      throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    }

    if (payment.status !== 'completed') {
      throw new AppError('Payment must be completed to process refund', 400, 'PAYMENT_NOT_COMPLETED');
    }

    // Process refund through Stripe
    const refundAmount = amount || Number(payment.amount);
    const refund = await stripeService.createRefund({
      paymentIntentId: payment.stripePaymentIntentId!,
      amount: refundAmount,
      reason: reason || 'Customer request',
      connectAccountId: payment.booking.activity.venue.stripeAccountId || undefined
    });

    // Update payment status
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        updatedAt: new Date(),
      }
    });

    // Update booking status if full refund
    if (refundAmount >= Number(payment.amount)) {
      await prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          status: 'cancelled',
          updatedAt: new Date(),
        }
      });
    }

    logger.info('Refund processed successfully', { 
      paymentId, 
      refundId: refund.id,
      amount: refundAmount 
    });

    res.json({
      success: true,
      message: 'Refund processed successfully',
      data: {
        refundId: refund.id,
        amount: refundAmount,
        status: 'refunded'
      }
    });
  } catch (error) {
    logger.error('Error processing refund:', error);
    throw error;
  }
}));

// Get refund history for a payment
router.get('/:paymentId/refunds', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    
    // Get payment to find the Stripe payment intent ID
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        isActive: true
      },
      select: {
        stripePaymentIntentId: true
      }
    });

    if (!payment) {
      throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    }

    if (!payment.stripePaymentIntentId) {
      throw new AppError('No Stripe payment intent found for this payment', 400, 'NO_STRIPE_PAYMENT_INTENT');
    }
    
    const refunds = await stripeService.listRefunds(payment.stripePaymentIntentId);
    
    res.json({
      success: true,
      data: refunds
    });
  } catch (error) {
    logger.error('Error fetching refunds:', error);
    throw error;
  }
}));

export default router;
