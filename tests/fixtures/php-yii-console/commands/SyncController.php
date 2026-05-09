<?php
namespace app\commands;

use yii\console\Controller;
use yii\console\ExitCode;

class SyncController extends Controller
{
    /**
     * Run a one-shot sync against the upstream API.
     */
    public function actionRun(string $repo, int $limit = 100): int
    {
        try {
            // ... do work ...
            return ExitCode::OK;
        } catch (\Throwable $e) {
            \Yii::error($e);
            return ExitCode::UNSPECIFIED_ERROR;
        }
    }

    /**
     * Variadic catch-all.
     */
    public function actionSweep(...$ids): int
    {
        return ExitCode::OK;
    }
}
