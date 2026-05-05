<?php
namespace app\controllers;

use yii\web\Controller;
use yii\filters\VerbFilter;

// Has behaviors() but with a non-AccessControl filter and no can() calls.
// Should land in controllers_without_access_control with reason
// "no-access-control-in-behaviors".
class MaintenanceController extends Controller
{
    public function behaviors()
    {
        return [
            'verbs' => [
                'class' => VerbFilter::class,
                'actions' => ['restart' => ['POST']],
            ],
        ];
    }

    public function actionRestart()
    {
        return 'restart';
    }
}
