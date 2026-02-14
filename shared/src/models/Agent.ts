import { DataTypes, Model } from 'sequelize';
import sequelize from '../database';

export interface AgentAttributes {
  id?: string;
  userId: string;
  projectId: string;
  environmentId: string;
  name: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Agent extends Model<AgentAttributes> implements AgentAttributes {
  declare id: string;
  declare userId: string;
  declare projectId: string;
  declare environmentId: string;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Agent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'user_id',
      references: {
        model: 'users',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'project_id',
      references: {
        model: 'projects',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    environmentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'environment_id',
      references: {
        model: 'environments',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      field: 'created_at',
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      field: 'updated_at',
    },
  },
  {
    sequelize,
    tableName: 'agents',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['environment_id', 'name'],
      },
      {
        fields: ['user_id', 'project_id'],
      },
    ],
  }
);

export default Agent;
