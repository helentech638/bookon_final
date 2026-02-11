import { prisma, safePrismaQuery } from '../utils/prisma';
import { logger } from '../utils/logger';

interface RegisterData {
  activityId: string;
  venueId: string;
  date: Date;
  notes?: string;
  status?: string;
}

class RegisterService {
  async createRegister(activityId: string, venueId: string, date: Date, notes?: string) {
    try {
      return await safePrismaQuery(async (client) => {
        // Verify activity exists
        const activity = await client.activity.findUnique({
          where: { id: activityId },
          select: {
            id: true,
            title: true,
            venueId: true
          }
        });

        if (!activity) {
          throw new Error('Activity not found');
        }

        // Verify venue matches activity venue
        if (activity.venueId !== venueId) {
          throw new Error('Venue does not match activity venue');
        }

        // Create register
        const register = await client.register.create({
          data: {
            activityId,
            venueId,
            date,
            notes,
            status: 'active'
          },
          include: {
            activity: {
              select: {
                title: true,
                type: true,
                venue: {
                  select: {
                    name: true,
                    address: true
                  }
                }
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          }
        });

        logger.info('Register created', {
          registerId: register.id,
          activityId,
          venueId,
          date
        });

        return register;
      });
    } catch (error) {
      logger.error('Failed to create register:', error);
      throw error;
    }
  }

  async getRegister(registerId: string) {
    try {
      return await safePrismaQuery(async (client) => {
        return await client.register.findUnique({
          where: { id: registerId },
          include: {
            activity: {
              select: {
                title: true,
                type: true,
                venue: {
                  select: {
                    name: true,
                    address: true
                  }
                }
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          }
        });
      });
    } catch (error) {
      logger.error('Failed to get register:', error);
      throw error;
    }
  }

  async getRegistersByActivity(activityId: string, dateFrom?: Date, dateTo?: Date) {
    try {
      return await safePrismaQuery(async (client) => {
        const where: any = { activityId };
        
        if (dateFrom || dateTo) {
          where.date = {};
          if (dateFrom) where.date.gte = dateFrom;
          if (dateTo) where.date.lte = dateTo;
        }

        return await client.register.findMany({
          where,
          include: {
            activity: {
              select: {
                title: true,
                type: true
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          },
          orderBy: { date: 'desc' }
        });
      });
    } catch (error) {
      logger.error('Failed to get registers by activity:', error);
      throw error;
    }
  }

  async getRegistersByVenue(venueId: string, dateFrom?: Date, dateTo?: Date) {
    try {
      return await safePrismaQuery(async (client) => {
        const where: any = { venueId };
        
        if (dateFrom || dateTo) {
          where.date = {};
          if (dateFrom) where.date.gte = dateFrom;
          if (dateTo) where.date.lte = dateTo;
        }

        return await client.register.findMany({
          where,
          include: {
            activity: {
              select: {
                title: true,
                type: true
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          },
          orderBy: { date: 'desc' }
        });
      });
    } catch (error) {
      logger.error('Failed to get registers by venue:', error);
      throw error;
    }
  }

  async updateRegister(registerId: string, data: Partial<RegisterData & { status?: string }>) {
    try {
      return await safePrismaQuery(async (client) => {
        const register = await client.register.update({
          where: { id: registerId },
          data: {
            ...(data.date && { date: data.date }),
            ...(data.notes !== undefined && { notes: data.notes }),
            ...(data.status && { status: data.status })
          },
          include: {
            activity: {
              select: {
                title: true,
                type: true
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          }
        });

        logger.info('Register updated', { registerId });

        return register;
      });
    } catch (error) {
      logger.error('Failed to update register:', error);
      throw error;
    }
  }

  async updateRegisterStatus(registerId: string, status: string) {
    try {
      return await safePrismaQuery(async (client) => {
        const register = await client.register.update({
          where: { id: registerId },
          data: { status },
          include: {
            activity: {
              select: {
                title: true,
                type: true
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          }
        });

        logger.info('Register status updated', { registerId, status });

        return register;
      });
    } catch (error) {
      logger.error('Failed to update register status:', error);
      throw error;
    }
  }

  async generateAttendanceReport(activityId: string, dateFrom: Date, dateTo: Date) {
    try {
      return await safePrismaQuery(async (client) => {
        const registers = await client.register.findMany({
          where: {
            activityId,
            date: {
              gte: dateFrom,
              lte: dateTo
            }
          },
          include: {
            activity: {
              select: {
                title: true,
                type: true
              }
            },
            venue: {
              select: {
                name: true,
                address: true
              }
            }
          },
          orderBy: { date: 'asc' }
        });

        // Get bookings for the same activity and date range to calculate attendance
        const bookings = await client.booking.findMany({
          where: {
            activityId,
            activityDate: {
              gte: dateFrom,
              lte: dateTo
            },
            status: 'confirmed'
          },
          include: {
            child: {
              select: {
                id: true,
                firstName: true,
                lastName: true
              }
            }
          }
        });

        const report = {
          activityId,
          dateFrom,
          dateTo,
          totalRegisters: registers.length,
          totalBookings: bookings.length,
          registers: registers.map(register => ({
            id: register.id,
            date: register.date,
            status: register.status,
            notes: register.notes,
            venue: register.venue.name,
            activity: register.activity.title
          }))
        };

        return report;
      });
    } catch (error) {
      logger.error('Failed to generate attendance report:', error);
      throw error;
    }
  }

  async deleteRegister(registerId: string) {
    try {
      await safePrismaQuery(async (client) => {
        await client.register.delete({
          where: { id: registerId }
        });
      });

      logger.info('Register deleted', { registerId });
    } catch (error) {
      logger.error('Failed to delete register:', error);
      throw error;
    }
  }

  async autoCreateRegistersForActivity(activityId: string, startDate: Date, endDate: Date) {
    try {
      return await safePrismaQuery(async (client) => {
        // Get activity details
        const activity = await client.activity.findUnique({
          where: { id: activityId },
          select: {
            id: true,
            venueId: true,
            title: true
          }
        });

        if (!activity) {
          throw new Error('Activity not found');
        }

        // Generate registers for each day in the date range
        const registers = [];
        const currentDate = new Date(startDate);
        
        while (currentDate <= endDate) {
          // Check if register already exists for this date
          const existingRegister = await client.register.findFirst({
            where: {
              activityId,
              date: {
                gte: new Date(currentDate.setHours(0, 0, 0, 0)),
                lt: new Date(currentDate.setHours(23, 59, 59, 999))
              }
            }
          });

          if (!existingRegister) {
            const register = await client.register.create({
              data: {
                activityId,
                venueId: activity.venueId,
                date: new Date(currentDate),
                status: 'active'
              }
            });
            registers.push(register);
          }

          // Move to next day
          currentDate.setDate(currentDate.getDate() + 1);
        }

        logger.info('Auto-created registers', {
          activityId,
          registersCreated: registers.length,
          dateRange: { startDate, endDate }
        });

        return registers;
      });
    } catch (error) {
      logger.error('Failed to auto-create registers:', error);
      throw error;
    }
  }
}

export const registerService = new RegisterService();
export default registerService;
