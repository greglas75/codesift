<?php

use yii\db\Migration;

class m180504_110045_users extends Migration
{
    public function up()
    {
        $this->createTable('users', [
            'id' => $this->primaryKey(),
            'email' => $this->string()->notNull(),
        ]);
    }

    public function down()
    {
        $this->dropTable('users');
    }
}
