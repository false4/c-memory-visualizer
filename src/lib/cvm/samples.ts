// 内置示例代码
export interface Sample {
  id: string;
  title: string;
  code: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'leak',
    title: '内存泄漏演示（默认）',
    code: `#include <stdio.h>
#include <stdlib.h>

int main() {
    int a = 10;                 // 栈：4 字节
    double b = 3.14;            // 栈：8 字节

    int *p = (int *)malloc(sizeof(int));      // 堆：4 字节
    *p = 42;
    printf("a=%d, *p=%d\\n", a, *p);

    int *arr = (int *)malloc(5 * sizeof(int)); // 堆：20 字节
    for (int i = 0; i < 5; i++) {
        arr[i] = i * i;
    }
    printf("arr[3]=%d\\n", arr[3]);

    free(p);                    // p 被正确释放
    // arr 忘记 free 了……
    return 0;                   // 程序结束：看看警告面板！
}
`,
  },
  {
    id: 'types',
    title: '基础类型与栈区',
    code: `#include <stdio.h>

int g_count = 100;              // 全局区

int main() {
    char c = 'A';               // 1 字节
    short s = 20;               // 2 字节
    int i = 42;                 // 4 字节
    long l = 1234567;           // 8 字节
    float f = 2.5;              // 4 字节
    double d = 3.1415926;       // 8 字节
    int nums[4] = {10, 20, 30, 40};  // 16 字节
    char name[8] = "kimi";      // 8 字节

    int *pi = &i;               // 指针也是变量：8 字节
    *pi = 99;

    printf("c=%c i=%d\\n", c, i);
    printf("sizeof(double)=%d\\n", sizeof(double));
    printf("nums[2]=%d name=%s\\n", nums[2], name);
    return 0;
}
`,
  },
  {
    id: 'frames',
    title: '函数调用与栈帧',
    code: `#include <stdio.h>
#include <stdlib.h>

int factorial(int n) {
    int result;                 // 每个调用一层新栈帧
    if (n <= 1) {
        result = 1;
    } else {
        result = n * factorial(n - 1);  // 递归：栈向上生长
    }
    return result;              // 返回后栈帧弹出
}

int main() {
    int n = 5;
    int r = factorial(n);
    printf("%d! = %d\\n", n, r);
    return 0;
}
`,
  },
  {
    id: 'heap',
    title: '堆数组与指针运算',
    code: `#include <stdio.h>
#include <stdlib.h>

int main() {
    int n = 6;
    int *data = (int *)calloc(n, sizeof(int));  // 堆：24 字节

    for (int i = 0; i < n; i++) {
        *(data + i) = (i + 1) * 10;   // 指针运算
    }

    int *cur = data;
    int sum = 0;
    while (cur < data + n) {
        sum += *cur;
        cur++;
    }
    printf("sum=%d\\n", sum);

    free(data);                  // 释放后变成"墓碑"块
    data = NULL;                 // 好习惯
    return 0;
}
`,
  },
  {
    id: 'bugs',
    title: '常见错误：重复释放 / 越界',
    code: `#include <stdio.h>
#include <stdlib.h>

int main() {
    int *p = (int *)malloc(sizeof(int));
    *p = 7;
    printf("*p=%d\\n", *p);

    free(p);
    printf("释放后再读：%d\\n", *p);  // use-after-free 警告
    free(p);                          // double free 错误

    int arr[3] = {1, 2, 3};
    arr[5] = 99;                      // 数组越界
    return 0;
}
`,
  },
];
