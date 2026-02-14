import { createServiceLogger } from '@whyops/shared/logger';
import { Entity } from '@whyops/shared/models';
import CryptoJS from 'crypto-js';

const logger = createServiceLogger('analyse:sampling-service');

export interface SamplingResult {
  shouldSample: boolean;
  samplingRate?: number;
  hashValue?: number;
  reason?: string;
}

export class SamplingService {
  /**
   * Determines if an event should be sampled based on entity's sampling rate
   * Uses deterministic hash-based sampling for consistency
   */
  static async shouldSampleEvent(
    userId: string,
    environmentId: string,
    entityName: string | undefined,
    eventHash: string
  ): Promise<SamplingResult> {
    // If no entity name, always sample
    if (!entityName) {
      return { shouldSample: true };
    }

    try {
      // Fetch entity with sampling configuration
      const entity = await Entity.findOne({
        where: { userId, environmentId, name: entityName },
        order: [['createdAt', 'DESC']],
      });

      // If entity not found or sampling rate is 1.0, always sample
      if (!entity || entity.samplingRate >= 1.0) {
        return { shouldSample: true, samplingRate: entity?.samplingRate };
      }

      // Generate deterministic value from hash (0-1 range)
      const hashValue = this.hashToNormalizedValue(eventHash);

      // Sample if hash value is within sampling rate
      const shouldSample = hashValue <= entity.samplingRate;

      logger.debug({
        entityId: entity.id,
        samplingRate: entity.samplingRate,
        hashValue: hashValue.toFixed(4),
        shouldSample,
      }, 'Sampling decision made');

      return {
        shouldSample,
        samplingRate: entity.samplingRate,
        hashValue,
        reason: shouldSample 
          ? undefined 
          : `Event rejected by sampling (rate: ${entity.samplingRate}, hash: ${hashValue.toFixed(4)})`,
      };
    } catch (error) {
      logger.error({ error, userId, environmentId, entityName }, 'Error in sampling decision, defaulting to sample');
      return { shouldSample: true, reason: 'Error in sampling, defaulting to accept' };
    }
  }

  /**
   * Converts a hash string to a normalized value between 0 and 1
   * Uses first 8 hex characters for deterministic distribution
   */
  private static hashToNormalizedValue(hash: string): number {
    const hashPrefix = hash.substring(0, 8);
    const hashInt = parseInt(hashPrefix, 16);
    return hashInt / 0xffffffff; // Normalize to [0, 1]
  }

  /**
   * Generates a content hash for an event
   */
  static generateContentHash(data: {
    traceId: string;
    eventType: string;
    userId: string;
    parentStepId?: number;
    content?: any;
  }): string {
    const payload = {
      traceId: data.traceId,
      eventType: data.eventType,
      userId: data.userId,
      parentStepId: data.parentStepId,
      content: data.content,
    };
    const rawString = JSON.stringify(payload);
    return CryptoJS.SHA256(rawString).toString();
  }
}
