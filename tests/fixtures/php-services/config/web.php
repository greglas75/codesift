<?php
return [
    'components' => [
        'db' => [
            'class' => 'yii\db\Connection',
            'dsn' => 'mysql:host=localhost;dbname=test',
        ],
        'user' => [
            'class' => 'app\components\UserComponent',
            'identityClass' => 'app\models\User',
        ],
        'mailer' => [
            'class' => 'app\components\Mailer',
            'useFileTransport' => true,
        ],
        // Sprint 3: factory closure — produced class can't be resolved statically.
        'cacheBuilder' => function () {
            return new \yii\caching\FileCache();
        },
    ],
    'modules' => [
        'review' => [
            'class' => 'app\modules\review\Module',
            'components' => [
                // Sprint 3: module-scoped component — should be tagged source="module:review"
                'notifier' => [
                    'class' => 'app\modules\review\components\Notifier',
                ],
            ],
        ],
    ],
    'container' => [
        'singletons' => [
            // Sprint 3: container singleton via 'container' => ['singletons' => [...]]
            'app\interfaces\LoggerInterface' => [
                'class' => 'app\components\FileLogger',
            ],
        ],
    ],
];
