import { DataTypes, QueryInterface } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('agents', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    project_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'projects',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    environment_id: {
      type: DataTypes.UUID,
      allowNull: false,
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
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  });

  await queryInterface.addConstraint('agents', {
    fields: ['environment_id', 'name'],
    type: 'unique',
    name: 'unique_environment_agent_name',
  });

  await queryInterface.addColumn('entities', 'agent_id', {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'agents',
      key: 'id',
    },
    onDelete: 'CASCADE',
  });

  await queryInterface.addIndex('entities', ['agent_id']);
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.removeIndex('entities', ['agent_id']);
  await queryInterface.removeColumn('entities', 'agent_id');
  await queryInterface.removeConstraint('agents', 'unique_environment_agent_name');
  await queryInterface.dropTable('agents');
}
