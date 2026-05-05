<?php
namespace app\commands;

use yii\console\Controller;

class RiskyController extends Controller
{
    // No return type, no try/catch, unbounded ->all(), echo direct.
    // Should surface 4 flags.
    public function actionExportAll()
    {
        $rows = User::find()->all();
        foreach ($rows as $u) {
            echo $u->email . "\n";
        }
    }

    // Has try/catch + ExitCode return — should surface 0 flags.
    public function actionSafeProcess(): int
    {
        try {
            return \yii\console\ExitCode::OK;
        } catch (\Throwable $e) {
            return \yii\console\ExitCode::UNSPECIFIED_ERROR;
        }
    }
}
