<?php
class ChainedController {
    public function actionChained() {
        $orders = Order::find()->all();
        foreach ($orders as $order) {
            echo $order->customer->address->city;
        }
    }
}
