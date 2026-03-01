import { DataTypes, QueryInterface } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  const tableExists = async (tableName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}')`
    );
    return (results as any[])[0]?.exists === true;
  };

  const indexExistsOnColumn = async (tableName: string, columnName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM pg_indexes WHERE tablename = '${tableName}' AND indexdef LIKE '%${columnName}%')`
    );
    return (results as any[])[0]?.exists === true;
  };

  if (!(await tableExists('users'))) {
    await queryInterface.createTable('users', {
      id: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      password_hash: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      organization_id: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
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

  if (!(await indexExistsOnColumn('users', 'email'))) {
    await queryInterface.addIndex('users', ['email'], { unique: true });
  }
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  const tableExists = async (tableName: string): Promise<boolean> => {
    const [results] = await queryInterface.sequelize.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}')`
    );
    return (results as any[])[0]?.exists === true;
  };

  if (await tableExists('users')) {
    await queryInterface.dropTable('users');
  }
}
