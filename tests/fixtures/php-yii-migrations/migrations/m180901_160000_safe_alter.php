<?php
use yii\db\Migration;

// Same destructive ops but with explicit ALGORITHM=INPLACE hint via raw
// execute() — should NOT fire alter-without-online-ddl.
class m180901_160000_safe_alter extends Migration
{
    public function up()
    {
        $this->execute("ALTER TABLE users ALGORITHM=INPLACE, LOCK=NONE, DROP COLUMN obsolete_col");
        $this->alterColumn('users', 'email', $this->string(255));
    }

    public function down()
    {
        // No-op intentionally — we just want to test the audit logic.
        $this->addColumn('users', 'obsolete_col', $this->string());
    }
}
