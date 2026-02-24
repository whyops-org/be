import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../database';

// Generic Event Type
export interface TraceEvent {
  id: string;
  traceId: string; // was threadId
  spanId?: string;
  stepId: number;
  parentStepId?: number;
  eventType: 'user_message' | 'llm_response' | 'tool_call' | 'tool_call_request' | 'tool_call_response' | 'tool_result' | 'error';
  userId: string;
  providerId?: string;
  timestamp: Date;
  
  // Generic Payload
  content: any; // JSONB
  
  // Metadata (Model, Provider, Latency, etc.)
  metadata?: Record<string, any>;
  
  createdAt: Date;
}

interface EventCreationAttributes extends Optional<TraceEvent, 'id' | 'createdAt'> {}

export class LLMEvent extends Model<TraceEvent, EventCreationAttributes> implements TraceEvent {
  declare id: string;
  declare traceId: string;
  declare spanId?: string;
  declare stepId: number;
  declare parentStepId?: number;
  declare eventType: 'user_message' | 'llm_response' | 'tool_call' | 'tool_call_request' | 'tool_call_response' | 'tool_result' | 'error';
  declare userId: string;
  declare providerId?: string;
  declare timestamp: Date;
  declare content: any;
  declare metadata?: Record<string, any>;
  declare createdAt: Date;
}

LLMEvent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    traceId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'trace_id',
    },
    spanId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'span_id',
    },
    stepId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'step_id',
    },
    parentStepId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'parent_step_id',
    },
    eventType: {
      type: DataTypes.STRING, // 'user_message', 'llm_response', etc.
      allowNull: false,
      field: 'event_type',
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
      field: 'user_id',
    },
    providerId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'providers',
        key: 'id',
      },
      field: 'provider_id',
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    content: {
      type: DataTypes.JSONB,
      allowNull: true, // Can be null for certain events? Best to allow null.
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'created_at',
    },
  },
  {
    sequelize,
    tableName: 'trace_events', // Rename table to be generic
    timestamps: true,
    updatedAt: false,
    indexes: [
      {
        fields: ['trace_id'],
      },
      {
        fields: ['user_id'],
      },
      {
        fields: ['provider_id'],
      },
      {
        fields: ['timestamp'],
      },
      {
        fields: ['trace_id', 'step_id'],
      },
    ],
  }
);

export default LLMEvent;
