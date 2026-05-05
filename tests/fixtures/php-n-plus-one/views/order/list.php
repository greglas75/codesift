<?php
/** @var $orders \app\models\Order[] */
?>
<table>
    <?php foreach ($orders as $order): ?>
        <tr>
            <td><?= $order->id ?></td>
            <!-- N+1 trigger: ->customer is a relation, not an eager-loaded property -->
            <td><?= $order->customer->name ?></td>
            <td><?= $order->getInvoice() ?></td>
        </tr>
    <?php endforeach; ?>
</table>
