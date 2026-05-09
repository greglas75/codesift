<?php
namespace app\controllers;

use yii\filters\AccessControl;
use yii\web\Controller;
use Yii;

class UserController extends Controller
{
    public function behaviors()
    {
        return [
            'access' => [
                'class' => AccessControl::class,
                'rules' => [
                    [
                        'allow' => true,
                        'permissions' => ['viewUser', 'orphanedCheck'],
                    ],
                ],
            ],
        ];
    }

    public function actionView($id)
    {
        // Code-level can() — orphan because never defined.
        if (!Yii::$app->user->can('editUser')) {
            throw new \yii\web\ForbiddenHttpException();
        }
        return 'ok';
    }
}
