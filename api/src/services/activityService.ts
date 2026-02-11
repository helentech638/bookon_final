import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';

class ActivityService {
  async createActivity(activityData: {
    title: string;
    type?: string;
    activityTypeId?: string;
    venueId: string;
    ownerId: string;
    description?: string;
    startDate: Date;
    endDate: Date;
    startTime: string;
    endTime: string;
    capacity: number;
    price: number;
    status?: string;
  }) {
    try {
      return await safePrismaQuery(async (client) => {
        const activity = await client.activity.create({
          data: {
            title: activityData.title,
            type: activityData.type,
            activityTypeId: activityData.activityTypeId,
            venueId: activityData.venueId,
            ownerId: activityData.ownerId,
            description: activityData.description,
            startDate: activityData.startDate,
            endDate: activityData.endDate,
            startTime: activityData.startTime,
            endTime: activityData.endTime,
            capacity: activityData.capacity,
            price: activityData.price,
            status: activityData.status || 'active',
            isActive: true,
          }
        });

        return activity;
      });
    } catch (error) {
      logger.error('Failed to create activity:', error);
      throw error;
    }
  }

  async updateActivityCapacity(activityId: string, newCapacity: number) {
    try {
      await safePrismaQuery(async (client) => {
        await client.activity.update({
          where: { id: activityId },
          data: { capacity: newCapacity }
        });
      });

      logger.info(`Updated capacity to ${newCapacity} for activity ${activityId}`);
    } catch (error) {
      logger.error('Failed to update activity capacity:', error);
      throw error;
    }
  }

  async getActivityWithDetails(activityId: string) {
    try {
      return await safePrismaQuery(async (client) => {
        return await client.activity.findUnique({
          where: { id: activityId },
          include: {
            venue: true,
            owner: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true
              }
            },
            activityType: true,
            bookings: {
              include: {
                child: true,
                parent: {
                  select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true
                  }
                }
              }
            },
            registers: true,
            _count: {
              select: {
                bookings: true,
                registers: true
              }
            }
          }
        });
      });
    } catch (error) {
      logger.error('Failed to get activity with details:', error);
      throw error;
    }
  }

  async getActivityStats(activityId: string) {
    try {
      return await safePrismaQuery(async (client) => {
        const activity = await client.activity.findUnique({
          where: { id: activityId },
          include: {
            bookings: {
              where: {
                status: { in: ['confirmed', 'pending'] }
              }
            },
            _count: {
              select: {
                bookings: true,
                registers: true
              }
            }
          }
        });

        if (!activity) return null;

        const confirmedBookings = activity.bookings.filter(b => b.status === 'confirmed').length;
        const utilizationRate = activity.capacity > 0 
          ? (confirmedBookings / activity.capacity) * 100 
          : 0;

        return {
          totalBookings: activity._count.bookings,
          confirmedBookings,
          totalRegisters: activity._count.registers,
          capacity: activity.capacity,
          utilizationRate: Math.round(utilizationRate * 100) / 100,
          availableSpots: activity.capacity - confirmedBookings
        };
      });
    } catch (error) {
      logger.error('Failed to get activity stats:', error);
      throw error;
    }
  }

  async deleteActivity(activityId: string) {
    try {
      await safePrismaQuery(async (client) => {
        // Check if activity has active bookings
        const activeBookings = await client.booking.findFirst({
          where: {
            activityId,
            status: { in: ['pending', 'confirmed'] }
          }
        });

        if (activeBookings) {
          throw new Error('Cannot delete activity with active bookings');
        }

        // Delete bookings first
        await client.booking.deleteMany({
          where: { activityId }
        });

        // Delete registers
        await client.register.deleteMany({
          where: { activityId }
        });

        // Delete the activity
        await client.activity.delete({
          where: { id: activityId }
        });
      });

      logger.info(`Deleted activity ${activityId} and all related data`);
    } catch (error) {
      logger.error('Failed to delete activity:', error);
      throw error;
    }
  }

  async archiveActivity(activityId: string) {
    try {
      await safePrismaQuery(async (client) => {
        await client.activity.update({
          where: { id: activityId },
          data: {
            isActive: false,
            status: 'inactive'
          }
        });
      });

      logger.info(`Archived activity ${activityId}`);
    } catch (error) {
      logger.error('Failed to archive activity:', error);
      throw error;
    }
  }

  async getActivitiesByVenue(venueId: string) {
    try {
      return await safePrismaQuery(async (client) => {
        return await client.activity.findMany({
          where: {
            venueId,
            isActive: true
          },
          include: {
            venue: true,
            activityType: true,
            _count: {
              select: {
                bookings: true,
                registers: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        });
      });
    } catch (error) {
      logger.error('Failed to get activities by venue:', error);
      throw error;
    }
  }

  async getActivitiesByType(type: string) {
    try {
      return await safePrismaQuery(async (client) => {
        return await client.activity.findMany({
          where: {
            type,
            isActive: true
          },
          include: {
            venue: true,
            activityType: true,
            _count: {
              select: {
                bookings: true,
                registers: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        });
      });
    } catch (error) {
      logger.error('Failed to get activities by type:', error);
      throw error;
    }
  }

  async updateActivity(activityId: string, updateData: {
    title?: string;
    type?: string;
    activityTypeId?: string;
    description?: string;
    startDate?: Date;
    endDate?: Date;
    startTime?: string;
    endTime?: string;
    capacity?: number;
    price?: number;
    status?: string;
    isActive?: boolean;
  }) {
    try {
      return await safePrismaQuery(async (client) => {
        return await client.activity.update({
          where: { id: activityId },
          data: updateData
        });
      });
    } catch (error) {
      logger.error('Failed to update activity:', error);
      throw error;
    }
  }
}

export const activityService = new ActivityService();
export default activityService;
