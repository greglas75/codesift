<?php
namespace app\commands;

use yii\console\Controller;
use Yii;

class SyncController extends Controller
{
    public function actionRun()
    {
        Yii::$app->queue->push(new SyncJob());
        Yii::info('Queued', __METHOD__);
    }
}
