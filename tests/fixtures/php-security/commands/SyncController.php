<?php
namespace app\commands;
use yii\console\Controller;

class SyncController extends Controller
{
    public function actionAll()
    {
        // yii-unbounded-all
        $rows = User::find()->where(['active' => 1])->all();
        foreach ($rows as $u) {
            // ...
        }
    }
}
