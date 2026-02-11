import { PrismaClient } from '@prisma/client';

// Create a global Prisma client instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Connection retry configuration
const createPrismaClient = () => {
  return new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: {
        // Use pooled connection URL for regular operations
        // DATABASE_URL should be the pooled URL, DATABASE_DIRECT_URL is for migrations only
        url: process.env['DATABASE_URL'] || '',
      },
    },
    // Add error handling for connection issues
    errorFormat: 'minimal',
  });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Add connection error handling
// prisma.$on('error', (e) => {
//   console.error('Prisma error:', e);
// });

// Graceful shutdown
if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Add connection health check
export const checkDatabaseConnection = async (): Promise<boolean> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('Database connection check failed:', error);
    return false;
  }
};

// Debug function to check which database URL is being used
export const getDatabaseInfo = () => {
  const dbUrl = process.env['DATABASE_URL'];
  const directUrl = process.env['DATABASE_DIRECT_URL'];
  
  return {
    hasPooledUrl: !!dbUrl,
    hasDirectUrl: !!directUrl,
    pooledUrlType: dbUrl?.includes('pooler') ? 'pooled' : 'direct',
    directUrlType: directUrl?.includes('pooler') ? 'pooled' : 'direct',
    // Don't log full URLs for security
    pooledUrlPreview: dbUrl ? `${dbUrl.substring(0, 20)}...` : 'NOT_SET',
    directUrlPreview: directUrl ? `${directUrl.substring(0, 20)}...` : 'NOT_SET'
  };
};

// Wrapper function to handle prepared statement errors
export const safePrismaQuery = async <T>(queryFn: (client: PrismaClient) => Promise<T>): Promise<T> => {
  try {
    return await queryFn(prisma);
  } catch (error: any) {
    // Check if it's a prepared statement error
    if (error.message && error.message.includes('prepared statement') && error.message.includes('does not exist')) {
      console.warn('Prepared statement error detected, retrying with fresh connection...');
      
      // Create a fresh Prisma client instance
      const freshClient = createPrismaClient();
      
      try {
        const result = await queryFn(freshClient);
        // Close the fresh client
        await freshClient.$disconnect();
        return result;
      } catch (retryError) {
        await freshClient.$disconnect();
        throw retryError;
      }
    }
    
    throw error;
  }
};

export default prisma;
