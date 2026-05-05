<?php
use yii\db\Migration;

class m180701_140000_drop_column extends Migration
{
    public function up()
    {
        // Destructive op without ALGORITHM=INPLACE/LOCK=NONE hint —
        // should fire alter-without-online-ddl.
        $this->dropColumn('users', 'legacy_field');
        $this->alterColumn('users', 'email', $this->string(255)->notNull());
    }

    public function down()
    {
        $this->addColumn('users', 'legacy_field', $this->string());
    }
}
