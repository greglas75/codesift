<?php
use yii\db\Migration;

class m180504_110045_users extends Migration
{
    public function up()
    {
        $this->createTable('users', [
            'id' => $this->primaryKey(),
            'email' => $this->string(120)->notNull(),
        ]);
        $this->createIndex('idx_users_email', 'users', 'email');
    }

    public function down()
    {
        $this->dropTable('users');
    }
}
