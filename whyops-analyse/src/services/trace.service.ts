import { createServiceLogger } from '@whyops/shared/logger';
import { Provider, Trace } from '@whyops/shared/models';
import { ParserFactory } from '../parsers';
import { EntityService } from './entity.service';

const logger = createServiceLogger('analyse:trace-service');

export interface TraceCreationData {
  traceId: string;
  userId: string;
  projectId: string;
  environmentId: string;
  providerId?: string;
  agentName: string;
  content?: any;
  metadata?: Record<string, any>;
  timestamp?: string;
}

export class TraceService {
  /**
   * Ensures a trace exists, creating it if necessary
   * Resolves entity and extracts metadata on first creation
   */
  static async ensureTraceExists(data: TraceCreationData): Promise<Trace | null> {
    // 1. Resolve agent version by name (must be initialized already)
    const resolvedAgentVersion = await EntityService.resolveLatestAgentVersionByName(
      data.userId,
      data.projectId,
      data.environmentId,
      data.agentName
    );

    if (!resolvedAgentVersion) {
      throw new Error(`Agent '${data.agentName}' is not initialized`);
    }

    // 2. Check if trace exists first (fast path)
    let trace = await Trace.findByPk(data.traceId);
    if (trace) {
      if (trace.entityId && trace.entityId !== resolvedAgentVersion.agentVersionId) {
        throw new Error('TRACE_AGENT_CONFLICT');
      }

      if (!trace.entityId) {
        trace.entityId = resolvedAgentVersion.agentVersionId;
      }

      if (!trace.providerId && data.providerId) {
        trace.providerId = data.providerId;
      }

      const fallbackMetadata = this.extractBestEffortMetadata(data.content, data.metadata);

      if (!trace.model && fallbackMetadata.model) {
        trace.model = fallbackMetadata.model;
      }

      if (!trace.systemMessage && fallbackMetadata.systemMessage) {
        trace.systemMessage = fallbackMetadata.systemMessage;
      }

      if (!trace.tools && fallbackMetadata.tools) {
        trace.tools = fallbackMetadata.tools;
      }

      if (trace.changed()) {
        await trace.save();
      }

      return trace;
    }

    // 3. Resolve Provider Type to select parser (if providerId is provided)
    let providerType = 'openai'; // default
    if (data.providerId) {
      try {
        const provider = await Provider.findByPk(data.providerId);
        if (provider) providerType = provider.type;
      } catch (e) {
        logger.warn(
          { providerId: data.providerId },
          'Failed to fetch provider type for trace init, using default'
        );
      }
    }

    // 4. Extract Metadata using Strategy Pattern
    const parser = ParserFactory.getParser(providerType);
    const metadata = parser.extract(data.content, data.metadata);

    // 5. Create Trace (using findOrCreate for safety)
    const [newTrace, created] = await Trace.findOrCreate({
      where: { id: data.traceId },
      defaults: {
        id: data.traceId,
        userId: data.userId,
        providerId: data.providerId,
        entityId: resolvedAgentVersion.agentVersionId,
        model: metadata.model,
        systemMessage: metadata.systemMessage,
        tools: metadata.tools,
        metadata: data.metadata,
        createdAt: data.timestamp ? new Date(data.timestamp) : new Date(),
      },
    });

    if (created) {
      logger.info(
        { traceId: newTrace.id, providerType, entityId: resolvedAgentVersion.agentVersionId },
        'Trace initialized'
      );
    }

    return newTrace;
  }

  private static extractBestEffortMetadata(content?: any, metadata?: Record<string, any>) {
    const openai = ParserFactory.getParser('openai').extract(content, metadata);
    const anthropic = ParserFactory.getParser('anthropic').extract(content, metadata);

    return {
      model: openai.model || anthropic.model,
      systemMessage: openai.systemMessage || anthropic.systemMessage,
      tools: openai.tools || anthropic.tools,
    };
  }
}
