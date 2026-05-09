<?php
use yii\widgets\ActiveForm;
use yii\grid\GridView;

$form = ActiveForm::begin();
echo GridView::widget(['dataProvider' => $dp]);
ActiveForm::end();
