<?php
use yii\db\Migration;

class m180801_150000_fk_no_index extends Migration
{
    public function safeUp()
    {
        $this->createTable('orders', [
            'id' => $this->primaryKey(),
            'user_id' => $this->integer()->notNull(),
        ]);
        // No createIndex on (orders, user_id) before this — should fire fk-without-index.
        $this->addForeignKey(
            'fk_orders_user',
            'orders',
            'user_id',
            'users',
            'id',
            'CASCADE'
        );
    }

    public function safeDown()
    {
        $this->dropForeignKey('fk_orders_user', 'orders');
        $this->dropTable('orders');
    }
}
