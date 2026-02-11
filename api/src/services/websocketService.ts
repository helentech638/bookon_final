// Conditional import for socket.io - optional dependency
let SocketIOServer: any;
let Socket: any;
try {
  const socketIO = require('socket.io');
  SocketIOServer = socketIO.Server;
  Socket = socketIO.Socket;
} catch (e) {
  // socket.io not installed - websocket features will be disabled
  SocketIOServer = null;
  Socket = null;
}

import { Server as HTTPServer } from 'http';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import jwt from 'jsonwebtoken';
import { prisma, safePrismaQuery } from '../utils/prisma';

export class WebSocketService {
  private io: any;
  private connectedUsers: Map<string, string> = new Map(); // userId -> socketId

  constructor(server: HTTPServer) {
    if (!SocketIOServer) {
      logger.warn('socket.io not installed - WebSocket features disabled');
      throw new Error('socket.io is required for WebSocketService');
    }
    
    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env['FRONTEND_URL'] || "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true
      }
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: any) => {
      logger.info('User connected to WebSocket', { socketId: socket.id });

      // Handle user authentication
      socket.on('authenticate', async (data: { userId: string, token: string }) => {
        try {
          // Verify JWT token
          const jwtSecret = process.env['JWT_SECRET'] || 'fallback-jwt-secret-for-development';
          const decoded = jwt.verify(data.token, jwtSecret) as any;
          
          // Verify user exists and is active
          const user = await safePrismaQuery(async (client) => {
            return await client.user.findUnique({
              where: { id: data.userId },
              select: { id: true, email: true, role: true, isActive: true }
            });
          });

          if (!user || !user.isActive) {
            throw new Error('User not found or inactive');
          }

          // Verify token belongs to user
          if (decoded.userId !== data.userId) {
            throw new Error('Token user mismatch');
          }

          this.connectedUsers.set(data.userId, socket.id);
          socket.join(`user:${data.userId}`);
          
          logger.info('User authenticated via WebSocket', { 
            userId: data.userId, 
            socketId: socket.id,
            userEmail: user.email,
            userRole: user.role
          });
          
          socket.emit('authenticated', { success: true });
        } catch (error) {
          logger.error('WebSocket authentication failed:', error);
          socket.emit('authentication_failed', { error: 'Invalid token' });
        }
      });

      // Handle venue room joining (for staff/admin)
      socket.on('join_venue', async (data: { venueId: string, userId: string }) => {
        try {
          // Verify user has access to venue
          const user = await prisma.user.findUnique({
            where: { id: data.userId },
            select: { id: true, role: true, venueId: true }
          });

          if (!user) {
            throw new Error('User not found');
          }

          // Check if user is admin or has access to this venue
          const hasAccess = user.role === 'admin' || user.venueId === data.venueId;
          
          if (!hasAccess) {
            throw new Error('Access denied to venue');
          }

          socket.join(`venue:${data.venueId}`);
          
          logger.info('User joined venue room', { 
            userId: data.userId, 
            venueId: data.venueId,
            socketId: socket.id,
            userRole: user.role
          });
          
          socket.emit('venue_joined', { venueId: data.venueId });
        } catch (error) {
          logger.error('Error joining venue room:', error);
          socket.emit('venue_join_failed', { error: 'Access denied' });
        }
      });

      // Handle notification acknowledgment
      socket.on('notification_read', (data: { notificationId: string }) => {
        try {
          NotificationService.markAsRead(data.notificationId);
          logger.info('Notification marked as read via WebSocket', { 
            notificationId: data.notificationId,
            socketId: socket.id 
          });
        } catch (error) {
          logger.error('Error marking notification as read:', error);
        }
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        // Remove user from connected users map
        for (const [userId, socketId] of this.connectedUsers.entries()) {
          if (socketId === socket.id) {
            this.connectedUsers.delete(userId);
            break;
          }
        }
        
        logger.info('User disconnected from WebSocket', { socketId: socket.id });
      });
    });
  }

  // Send notification to specific user
  public sendNotificationToUser(userId: string, notification: any) {
    const socketId = this.connectedUsers.get(userId);
    if (socketId) {
      this.io.to(socketId).emit('notification', notification);
      logger.info('Notification sent via WebSocket', { userId, notificationId: notification.id });
    } else {
      logger.info('User not connected to WebSocket', { userId });
    }
  }

  // Broadcast notification to venue
  public broadcastToVenue(venueId: string, event: string, data: any) {
    this.io.to(`venue:${venueId}`).emit(event, data);
    logger.info('Broadcast sent to venue', { venueId, event });
  }

  // Send real-time booking update
  public sendBookingUpdate(booking: any) {
    // Send to user who made the booking
    this.sendNotificationToUser(booking.userId, {
      type: 'booking_update',
      data: booking,
      timestamp: new Date().toISOString()
    });

    // Broadcast to venue staff
    this.broadcastToVenue(booking.venueId, 'booking_updated', {
      bookingId: booking.id,
      status: booking.status,
      timestamp: new Date().toISOString()
    });
  }

  // Send real-time payment update
  public sendPaymentUpdate(booking: any, paymentStatus: string) {
    // Send to user who made the booking
    this.sendNotificationToUser(booking.userId, {
      type: 'payment_update',
      data: {
        bookingId: booking.id,
        status: paymentStatus,
        amount: booking.total_amount
      },
      timestamp: new Date().toISOString()
    });

    // Broadcast to venue staff
    this.broadcastToVenue(booking.venueId, 'payment_updated', {
      bookingId: booking.id,
      status: paymentStatus,
      amount: booking.total_amount,
      timestamp: new Date().toISOString()
    });
  }

  // Send activity capacity update
  public sendCapacityUpdate(activity: any) {
    this.broadcastToVenue(activity.venueId, 'capacity_updated', {
      activityId: activity.id,
      availableSpots: activity.capacity - activity.booked_spots,
      totalCapacity: activity.capacity,
      timestamp: new Date().toISOString()
    });
  }

  // Send system alert
  public sendSystemAlert(venueId: string, message: string, priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium') {
    this.broadcastToVenue(venueId, 'system_alert', {
      message,
      priority,
      timestamp: new Date().toISOString()
    });
  }

  // Get connected users count
  public getConnectedUsersCount(): number {
    return this.connectedUsers.size;
  }

  // Get connected users for venue
  public getConnectedUsersForVenue(_venueId: string): string[] {
    // This would require additional tracking of venue associations
    // For now, return empty array
    return [];
  }

  // Send maintenance notification
  public sendMaintenanceNotification(message: string) {
    this.io.emit('maintenance_notification', {
      message,
      timestamp: new Date().toISOString()
    });
  }

  // Send server restart notification
  public sendServerRestartNotification() {
    this.io.emit('server_restart', {
      message: 'Server will restart in 30 seconds',
      timestamp: new Date().toISOString()
    });
    
    // Disconnect all clients after 30 seconds
    setTimeout(() => {
      this.io.disconnectSockets();
    }, 30000);
  }
}

// Global instance
let webSocketService: WebSocketService | null = null;

export function initializeWebSocket(server: HTTPServer): WebSocketService {
  if (!webSocketService) {
    webSocketService = new WebSocketService(server);
  }
  return webSocketService;
}

export function getWebSocketService(): WebSocketService | null {
  return webSocketService;
}

export default WebSocketService;
