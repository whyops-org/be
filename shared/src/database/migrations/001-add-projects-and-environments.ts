import { DataTypes, QueryInterface } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  // Helper to check if table exists
  const tableExists = async (tableName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}')`
    );
    return (results as any[])[0]?.exists === true;
  };

  // Helper to check if column exists
  const columnExists = async (tableName: string, columnName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name = '${tableName}' AND column_name = '${columnName}')`
    );
    return (results as any[])[0]?.exists === true;
  };

  // Helper to check if constraint exists
  const constraintExists = async (tableName: string, constraintName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM pg_constraint WHERE conname = '${constraintName}')`
    );
    return (results as any[])[0]?.exists === true;
  };

  // Helper to check if index exists on a column
  const indexExistsOnColumn = async (tableName: string, columnName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM pg_indexes WHERE tablename = '${tableName}' AND indexdef LIKE '%${columnName}%')`
    );
    return (results as any[])[0]?.exists === true;
  };

  // Create projects table
  if (!(await tableExists('projects'))) {
    await queryInterface.createTable('projects', {
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
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });
  }

  // Create environments table
  if (!(await tableExists('environments'))) {
    await queryInterface.createTable('environments', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
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
      name: {
        type: DataTypes.ENUM('PRODUCTION', 'STAGING', 'DEVELOPMENT'),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });
  }

  // Add unique constraint on project_id + name
  if (!(await constraintExists('environments', 'unique_project_environment'))) {
    await queryInterface.addConstraint('environments', {
      fields: ['project_id', 'name'],
      type: 'unique',
      name: 'unique_project_environment',
    });
  }

  // Add columns to api_keys table
  if (!(await columnExists('api_keys', 'project_id'))) {
    await queryInterface.addColumn('api_keys', 'project_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'projects',
        key: 'id',
      },
      onDelete: 'CASCADE',
    });
  }

  if (!(await columnExists('api_keys', 'environment_id'))) {
    await queryInterface.addColumn('api_keys', 'environment_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'environments',
        key: 'id',
      },
      onDelete: 'CASCADE',
    });
  }

  if (!(await columnExists('api_keys', 'entity_id'))) {
    await queryInterface.addColumn('api_keys', 'entity_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'entities',
        key: 'id',
      },
      onDelete: 'CASCADE',
    });
  }

  if (!(await columnExists('api_keys', 'is_master'))) {
    await queryInterface.addColumn('api_keys', 'is_master', {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    });
  }

  // Update provider_id to be nullable
  try {
    await queryInterface.changeColumn('api_keys', 'provider_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'providers',
        key: 'id',
      },
      onDelete: 'CASCADE',
    });
  } catch (error) {
    console.log('Could not change provider_id column, might already be updated');
  }

  // Update key_prefix to support longer prefixes
  try {
    await queryInterface.changeColumn('api_keys', 'key_prefix', {
      type: DataTypes.STRING(20),
      allowNull: false,
    });
  } catch (error) {
    console.log('Could not change key_prefix column, might already be updated');
  }

  // Add indexes for api_keys
  if (!(await indexExistsOnColumn('api_keys', 'project_id'))) {
    await queryInterface.addIndex('api_keys', ['project_id']);
  }
  if (!(await indexExistsOnColumn('api_keys', 'environment_id'))) {
    await queryInterface.addIndex('api_keys', ['environment_id']);
  }
  if (!(await indexExistsOnColumn('api_keys', 'is_master'))) {
    await queryInterface.addIndex('api_keys', ['is_master']);
  }

  // Add columns to entities table
  if (!(await columnExists('entities', 'project_id'))) {
    await queryInterface.addColumn('entities', 'project_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'projects',
        key: 'id',
      },
      onDelete: 'CASCADE',
    });
  }

  if (!(await columnExists('entities', 'environment_id'))) {
    await queryInterface.addColumn('entities', 'environment_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'environments',
        key: 'id',
      },
      onDelete: 'CASCADE',
    });
  }

  // Add indexes for entities
  if (!(await indexExistsOnColumn('entities', 'project_id'))) {
    await queryInterface.addIndex('entities', ['project_id']);
  }
  if (!(await indexExistsOnColumn('entities', 'environment_id'))) {
    await queryInterface.addIndex('entities', ['environment_id']);
  }

  // Remove old unique constraint and add new one
  try {
    await queryInterface.removeConstraint('entities', 'entities_user_id_name_hash_key');
  } catch (error) {
    console.log('Could not remove old constraint, might not exist');
  }

  if (!(await constraintExists('entities', 'unique_environment_entity'))) {
    await queryInterface.addConstraint('entities', {
      fields: ['environment_id', 'name', 'hash'],
      type: 'unique',
      name: 'unique_environment_entity',
    });
  }
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  // Remove indexes from entities
  await queryInterface.removeIndex('entities', ['environment_id']);
  await queryInterface.removeIndex('entities', ['project_id']);

  // Remove constraint from entities
  await queryInterface.removeConstraint('entities', 'unique_environment_entity');

  // Remove columns from entities
  await queryInterface.removeColumn('entities', 'environment_id');
  await queryInterface.removeColumn('entities', 'project_id');

  // Remove indexes from api_keys
  await queryInterface.removeIndex('api_keys', ['is_master']);
  await queryInterface.removeIndex('api_keys', ['environment_id']);
  await queryInterface.removeIndex('api_keys', ['project_id']);

  // Revert api_keys columns
  await queryInterface.changeColumn('api_keys', 'key_prefix', {
    type: DataTypes.STRING(12),
    allowNull: false,
  });

  await queryInterface.changeColumn('api_keys', 'provider_id', {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'providers',
      key: 'id',
    },
    onDelete: 'CASCADE',
  });

  await queryInterface.removeColumn('api_keys', 'is_master');
  await queryInterface.removeColumn('api_keys', 'entity_id');
  await queryInterface.removeColumn('api_keys', 'environment_id');
  await queryInterface.removeColumn('api_keys', 'project_id');

  // Remove constraint from environments
  await queryInterface.removeConstraint('environments', 'unique_project_environment');

  // Drop environments table
  await queryInterface.dropTable('environments');

  // Drop projects table
  await queryInterface.dropTable('projects');
}
