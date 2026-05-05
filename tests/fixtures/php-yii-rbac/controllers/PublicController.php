<?php
namespace app\controllers;

use yii\web\Controller;

// Controller with no behaviors() method at all — should land in
// controllers_without_access_control with reason="no-behaviors".
class PublicController extends Controller
{
    public function actionIndex()
    {
        return 'public';
    }
}
