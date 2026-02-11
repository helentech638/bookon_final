// Load environment variables FIRST before any other imports
import dotenv from 'dotenv';
import path from 'path';

// Load .env file from api directory (one level up from src/)
// When running from api directory, __dirname will be api/src, so ../.env is correct
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import 'express-async-errors';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';

// Immediate logging to see if module loads
console.log('🚀 Backend module loading...');
console.log('📊 Environment:', process.env['NODE_ENV'] || 'development');
console.log('🔗 Port:', process.env['PORT'] || 3000);

// Import routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import notificationRoutes from './routes/notifications';
import childrenRoutes from './routes/children';
import dashboardRoutes from './routes/dashboard';
import activitiesRoutes from './routes/activities';
import activityTypesRoutes from './routes/activity-types';
import venuesRoutes from './routes/venues';
import bookingsRoutes from './routes/bookings';
import paymentsRoutes from './routes/payments';
import adminRoutes from './routes/admin';
import widgetRoutes from './routes/widget';
import widgetConfigRoutes from './routes/widget-config';
import registersRoutes from './routes/registers';
import webhooksRoutes from './routes/webhooks';
import setupRoutes from './routes/setup';
import tfcRoutes from './routes/tfc';
import adminTfcRoutes from './routes/admin-tfc';
import cancellationRoutes from './routes/cancellations';
import walletRoutes from './routes/wallet';
import providerSettingsRoutes from './routes/provider-settings';
import auditRoutes from './routes/audit';
import edgeCaseRoutes from './routes/edge-cases';
import dataRetentionRoutes from './routes/data-retention';
import dashboardSnapshotRoutes from './routes/dashboard-snapshot';
import upcomingActivitiesRoutes from './routes/upcoming-activities';
import financeSummaryRoutes from './routes/finance-summary';
import notificationsRoutes from './routes/notifications';
import templatesRoutes from './routes/templates';
import coursesRoutes from './routes/courses';
import businessAccountsRoutes from './routes/business-accounts';
import financeReportingRoutes from './routes/finance-reporting';
import communicationsRoutes from './routes/communications';
import financeRoutes from './routes/finance';
import healthRoutes from './routes/health';

// Import middleware
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { logger } from './utils/logger';
import { cronService } from './services/cronService';
import { schedulerService } from './services/schedulerService';

// Import database connection
import { connectDatabase } from './utils/database';

// Import WebSocket service
import { initializeWebSocket } from './services/websocketService';

const app = express();
const server = createServer(app);
const PORT = process.env['PORT'] || 3000;

// Trust proxy for Vercel deployment
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'", "https://js.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3001',
    'https://bookon-frontend.vercel.app',
    process.env['FRONTEND_URL'] || 'http://localhost:3001'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] || '900000'), // 15 minutes
      max: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] || '100'), // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
          retryAfter: Math.ceil(parseInt(process.env['RATE_LIMIT_WINDOW_MS'] || '900000') / 1000),
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Speed limiting
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50, // allow 50 requests per 15 minutes, then...
  delayMs: 500, // begin adding 500ms of delay per request above 50
});

app.use('/api/', limiter);
app.use('/api/', speedLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Logging middleware
app.use(morgan('combined', {
  stream: {
    write: (message: string) => logger.info(message.trim()),
  },
}));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env['NODE_ENV'] || 'development',
    version: process.env['npm_package_version'] || '1.0.0',
  });
});

// Debug endpoint to test server startup
app.get('/debug', (_req, res) => {
  res.status(200).json({
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    env: process.env['NODE_ENV'] || 'development',
    databaseUrl: process.env['DATABASE_URL'] ? 'SET' : 'MISSING',
    jwtSecret: process.env['JWT_SECRET'] ? 'SET' : 'MISSING',
  });
});

// Simple test endpoint
app.get('/test', (_req, res) => {
  res.status(200).json({
    message: 'Backend is working!',
    timestamp: new Date().toISOString(),
    routes: app._router.stack.map((layer: any) => layer.route?.path).filter(Boolean)
  });
});

// Very simple ping endpoint
app.get('/ping', (_req, res) => {
  res.status(200).json({ message: 'pong', timestamp: new Date().toISOString() });
});

// Simple API test endpoint
app.get('/api/test', (_req, res) => {
  res.status(200).json({ 
    message: 'Backend API is working!', 
    timestamp: new Date().toISOString(),
    environment: process.env['NODE_ENV'] || 'development'
  });
});

// Simple token verification endpoint
app.get('/api/verify-token', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'No token provided' 
      });
    }
    
    // For now, just check if token exists and has reasonable length
    if (token.length > 10) {
      return res.status(200).json({ 
        success: true, 
        message: 'Token format looks valid',
        tokenLength: token.length
      });
    } else {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token format' 
      });
    }
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      message: 'Token verification error' 
    });
  }
});

// Simple database test endpoint
app.get('/api/test-db', async (_req, res) => {
  try {
    const { prisma } = await import('./utils/prisma');
    
    // Test simple database query
    const userCount = await prisma.user.count();
    const venueCount = await prisma.venue.count();
    const activityCount = await prisma.activity.count();
    const bookingCount = await prisma.booking.count();
    
    res.json({
      success: true,
      message: 'Database connection working',
      data: {
        users: userCount,
        venues: venueCount,
        activities: activityCount,
        bookings: bookingCount
      }
    });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// Simple mock login endpoint for testing
app.post('/api/mock-login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('Mock login attempt:', { email, hasPassword: !!password });
    
    if (email === 'test@bookon.com' || email === 'admin@bookon.com') {
      const mockUser = {
        id: 'mock-user-id',
        email: email,
        role: email === 'admin@bookon.com' ? 'admin' : 'parent',
        isActive: true
      };

      // Generate simple tokens (without JWT for now)
      const accessToken = 'mock-access-token-' + Date.now();
      const refreshToken = 'mock-refresh-token-' + Date.now();

      console.log('Mock login successful:', mockUser.email);

      return res.json({
        success: true,
        message: 'Login successful (mock mode)',
        data: {
          user: mockUser,
          tokens: {
            accessToken,
            refreshToken,
          },
        },
      });
    } else {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS',
        },
      });
    }
  } catch (error) {
    console.error('Mock login error:', error);
    return res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error',
        code: 'INTERNAL_ERROR',
      },
    });
  }
});

// Root endpoint
app.get('/', (_req, res) => {
  res.status(200).json({
    message: 'BookOn Backend API',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      ping: '/ping',
      health: '/health',
      debug: '/debug',
      test: '/test',
      api: '/api/v1'
    }
  });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/children', childrenRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/activities', activitiesRoutes);
app.use('/api/v1/activity-types', activityTypesRoutes);
app.use('/api/v1/venues', venuesRoutes);
app.use('/api/v1/bookings', bookingsRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/widget', widgetRoutes);
app.use('/api/v1/widget-config', widgetConfigRoutes);
app.use('/api/v1/registers', registersRoutes);
app.use('/api/v1/webhooks', webhooksRoutes);
app.use('/api/v1/setup', setupRoutes);
app.use('/api/v1/tfc', tfcRoutes);
app.use('/api/v1/admin/tfc', adminTfcRoutes);
app.use('/api/v1/cancellations', cancellationRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/provider-settings', providerSettingsRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/edge-cases', edgeCaseRoutes);
app.use('/api/v1/data-retention', dataRetentionRoutes);
app.use('/api/v1/dashboard', dashboardSnapshotRoutes);
app.use('/api/v1/activities', upcomingActivitiesRoutes);
app.use('/api/v1/finance', financeSummaryRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/templates', templatesRoutes);
app.use('/api/v1/courses', coursesRoutes);
app.use('/api/v1/business-accounts', businessAccountsRoutes);
app.use('/api/v1/finance', financeReportingRoutes);
app.use('/api/v1/communications', communicationsRoutes);
app.use('/api/v1/finance', financeRoutes);
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/webhooks', webhooksRoutes);
app.use('/api/v1/registers', registersRoutes);
app.use('/api/v1/tfc', tfcRoutes);

// Webhook endpoint for Stripe
app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }));

// 404 handler
app.use(notFound);

// Error handling middleware (must be last)
app.use(errorHandler);

// Unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  process.exit(1);
});

// Uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

// Handle SIGINT gracefully
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
const startServer = async () => {
  try {
    console.log('🚀 Starting BookOn server...');
    logger.info('🚀 Starting BookOn server...');
    logger.info(`📊 Environment: ${process.env['NODE_ENV'] || 'development'}`);
    logger.info(`🔗 Port: ${PORT}`);
    
    // Check environment variables
    const requiredEnvVars = ['JWT_SECRET', 'JWT_REFRESH_SECRET'];
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingEnvVars.length > 0) {
      console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
      logger.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
      logger.error('Please check your Vercel environment variables configuration');
      // Don't exit in production, continue with mock mode
      if (process.env['NODE_ENV'] === 'production') {
        console.log('⚠️ Continuing in mock mode due to missing environment variables');
        logger.warn('⚠️ Continuing in mock mode due to missing environment variables');
      } else {
        console.log('⚠️ Development mode - continuing without environment variables');
        logger.warn('⚠️ Development mode - continuing without environment variables');
      }
    } else {
      console.log('✅ Environment variables check passed');
      logger.info('✅ Environment variables check passed');
    }

    // Try to connect to database
    try {
      console.log('🔌 Attempting to connect to database...');
      logger.info('🔌 Attempting to connect to database...');
      
      // Log database URL (without password for security)
      const dbUrl = process.env['DATABASE_URL'];
      if (dbUrl) {
        const urlParts = dbUrl.split('@');
        if (urlParts.length > 1) {
          const hostPart = urlParts[1];
          logger.info(`📊 Database host: ${hostPart}`);
        }
      } else {
        logger.warn('⚠️ DATABASE_URL not found in environment variables');
      }
      
      await connectDatabase();
      console.log('✅ Database connected successfully');
      logger.info('✅ Database connected successfully');
    } catch (dbError) {
      console.error('❌ Database connection failed:', dbError);
      logger.error('❌ Database connection failed:', dbError);
      logger.error('❌ Database error details:', {
        message: dbError instanceof Error ? dbError.message : 'Unknown error',
        stack: dbError instanceof Error ? dbError.stack : undefined,
        env: process.env['NODE_ENV'],
        hasDatabaseUrl: !!process.env['DATABASE_URL']
      });
      
      // Don't let database connection failure prevent server startup
      console.warn('⚠️ Continuing without database connection - will use mock mode');
      logger.warn('⚠️ Continuing without database connection - will use mock mode');
    }

    // Initialize WebSocket service
    try {
      initializeWebSocket(server);
      logger.info('🔌 WebSocket service initialized');
    } catch (error: any) {
      logger.warn('⚠️ WebSocket service not available:', error.message || 'socket.io not installed');
    }

    // Start cron service for automated notifications
    cronService.start();
    logger.info('⏰ Cron service started');

    // Initialize scheduled jobs for TFC and wallet management
    schedulerService.initializeScheduledJobs();
    logger.info('⏰ Scheduled jobs initialized');

    // Start HTTP server
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📊 Environment: ${process.env['NODE_ENV'] || 'development'}`);
      logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
      logger.info(`🔍 Debug info: http://localhost:${PORT}/debug`);
      logger.info(`🧪 Test endpoint: http://localhost:${PORT}/test`);
      logger.info(`📚 API docs: http://localhost:${PORT}/api/v1/docs`);
      logger.info(`🔌 WebSocket: ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    logger.error('❌ Failed to start server:', error);
    // Don't exit in production, let Vercel handle it
    if (process.env['NODE_ENV'] !== 'production') {
      process.exit(1);
    }
  }
};

startServer();

export default app;
